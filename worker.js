// おえかきジャンプ：ランキングの API。それ以外のパスは静的ファイル（index.html など）をそのまま返す
//   GET  /api/rank              → {time30:{all:[…],day:[…]}, ta1000:{all:[…],day:[…]}, day:'YYYY-MM-DD'}
//                                  1件は {id,u,s,n,e,t}（u なまえ、s 記録、n 形の名前、e 特殊効果の id、t 登録時刻）
//   POST /api/rank {m,s,u,n,e,d,at} → 中身を検証し、全期間か今日の上位に入れば保存して {pos,dpos,id,best,…上と同じ一覧}
//                                  m は time30（s＝高さ m・多いほど上）か ta1000（s＝秒・少ないほど上）
//                                  d は端末番号（無いものは受け付けない）。各一覧に1端末1件（自己ベストだけ）。より良い記録なら入れ替えて best=true
//                                  at はその記録を出した時刻。今日の一覧には、今日出した記録だけを入れる（ゲームは自己ベストを送る）
//   POST /api/play {e,f,v,l}     → 1回の遊びを数えて、調整用に1行残す（e はプレイごとの番号。同じ e の送り直しは数えない）
//                                  f=1 ならその端末で初めて遊んだ回（＝新しい人）。v は版。l は {mode,why,m,t,clear,n,e1,e2,src,ext,stage}
//                                  （モード・終わったわけ・高さ・秒・ゴールしたか・形の名前・特殊効果・見本か自作か・描いた大きさ・チュートリアルの段）
//   GET  /stats                  → 合言葉の入力欄だけ
//   POST /stats {k,a,id,ver}     → 合言葉が合えば、集計（日本時間の日ごと）・分析・ランキングの全件を見せる
//                                  a=reset で集計を0に（ランキングは残す）、a=del でランキングの1件を消す、a=csv で記録を CSV で保存
//   POST /admin {k,a,id}         → 合言葉が合えば、a=list で全件（JSON）、a=del で id の1件を消す。GET /admin は /stats へ
//                                  合言葉は Cloudflare の Secret「ADMIN_KEY」に登録する（コードには書かない。未登録なら使えない）
// 保存先は Durable Object（SQLite、無料プランで使える）1つ。描いた絵は受け取らない（大きさの数字だけ）
// 自由な文字は受け取らない。なまえはひらがな・カタカナ8文字まで、形の名前と特殊効果はゲームの語だけを通す
import {DurableObject} from 'cloudflare:workers';

const KEEP=100;
const MODES={time30:{dir:1,lo:1,hi:3000,int:true},ta1000:{dir:-1,lo:12,hi:900,int:false}};   // 記録の範囲（ゲームで出せる値に合わせる）
const SHAPE_NAMES=['まるがた','まんまる','たまご','しかく','さんかく','たてなが','よこなが','とげとげ','じぐざぐ','かぎ','くるり','ぼう','かたまり','くねくね','ふしぎ'];
const EFFECT_IDS=['bounce','swing','kick','stab','high','glide','air','big'];
// なまえ：ひらがな・カタカナ・「ー」で8文字まで（空なら名無し）。よくある悪口は弾く（カタカナはひらがなに直して比べる）
const NAME_NG=['しね','しんで','ころす','ころせ','ちんこ','ちんぽ','まんこ','せっくす','れいぷ','きちがい','がいじ','うんこ','ぶす','かす'];
const hira=s=>s.replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60));
function validUser(u){
  if(u===undefined||u==='')return '';
  if(typeof u!=='string'||!/^[ぁ-ゖァ-ヺー]{1,8}$/.test(u)||NAME_NG.some(w=>hira(u).includes(w)))return null;
  return u;
}
function valid(b){
  if(!b||typeof b!=='object')return null;
  const M=MODES[b.m],u=validUser(b.u);
  if(!M||u===null)return null;
  const s=b.s;
  if(typeof s!=='number'||!isFinite(s)||s<M.lo||s>M.hi)return null;
  if(M.int?!Number.isInteger(s):Math.round(s*100)!==+(s*100).toFixed(6))return null;   // 高さは整数、秒は小数2桁まで
  if(!SHAPE_NAMES.includes(b.n))return null;
  if(!Array.isArray(b.e)||b.e.length<1||b.e.length>2||!b.e.every(x=>EFFECT_IDS.includes(x))||new Set(b.e).size!==b.e.length)return null;
  return {m:b.m,s,u,n:b.n,e:b.e.slice()};
}
// 調整用の記録（1回の遊びで1行）。決まった語と範囲の数だけを通す
const LOG_KEEP=200000;   // 新しい20万件だけ残す
const LOG_COLS=['eid','t','ver','first','mode','why','m','secs','clear','n','e1','e2','src','ext','stage'];
const WHYS=['time','goal','tide','enemy','spike','quit'];
function cleanLog(L,ver){
  if(!L||typeof L!=='object')return null;
  const num=(x,lo,hi,d)=>typeof x==='number'&&isFinite(x)?+Math.min(hi,Math.max(lo,x)).toFixed(d):null;
  const pick=(x,list)=>list.includes(x)?x:null;
  return {ver:typeof ver==='string'&&/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ver)?ver:null,
    mode:pick(L.mode,['time30','ta1000','normal','tut']),why:pick(L.why,WHYS),m:num(L.m,0,100000,0),secs:num(L.t,0,3600,2),clear:L.clear?1:0,
    n:pick(L.n,SHAPE_NAMES),e1:pick(L.e1,EFFECT_IDS),e2:pick(L.e2,EFFECT_IDS),src:pick(L.src,['tpl','own']),ext:num(L.ext,0,400,0),stage:num(L.stage,0,9,0)};
}
function json(o,status){return new Response(JSON.stringify(o),{status:status||200,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
const errText=e=>String(e&&e.message||e).slice(0,120);
// 端末の見分け（1人1件のため）。ゲームが送る端末番号 d を、ここでハッシュにして dh として持つ。dh は外へ出さない
async function devHash(d){
  if(typeof d!=='string'||!/^[0-9a-f]{16,32}$/.test(d))return '';
  const h=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('oekaki-jump-dev:'+d)));
  return [...h.slice(0,12)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const pub=l=>l.map(({dh,...e})=>e);
const jstDay=t=>new Date(t+9*3600e3).toISOString().slice(0,10);   // 日本時間の日付

// ランキングを持つ Durable Object（1つだけ使う）。中の処理は1件ずつ順番に動くので、同時に書いても壊れない
export class Board extends DurableObject{
  constructor(ctx,env){
    super(ctx,env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS plays_log(eid TEXT PRIMARY KEY,t INTEGER,ver TEXT,first INTEGER,mode TEXT,why TEXT,m INTEGER,secs REAL,clear INTEGER,n TEXT,e1 TEXT,e2 TEXT,src TEXT,ext INTEGER,stage INTEGER)`);
  }
  async lists(m){
    const s=this.ctx.storage,today=jstDay(Date.now());
    const all=(await s.get('all:'+m))||[],day=(await s.get('day:'+m))||{d:today,l:[]};
    return {all,day:day.d===today?day.l:[],today};
  }
  async view(){
    const o={day:jstDay(Date.now())};
    for(const m of Object.keys(MODES)){const L=await this.lists(m);o[m]={all:pub(L.all),day:pub(L.day)};}
    return o;
  }
  async submit(v){
    const M=MODES[v.m],L=await this.lists(v.m),better=(a,b)=>M.dir>0?a>b:a<b;
    // その一覧に入るか。入るなら、入れ替える自分の古い記録の位置（無ければ -1）
    const plan=l=>{
      const i=v.dh?l.findIndex(e=>e.dh===v.dh):-1;
      if(i>=0)return better(v.s,l[i].s)?{i}:null;
      return l.length<KEEP||better(v.s,l[l.length-1].s)?{i:-1}:null;
    };
    const pA=plan(L.all),pD=v.day===false?null:plan(L.day),posOf=(l,id)=>{const i=id?l.findIndex(x=>x.id===id):-1;return i>=0?i+1:null;};
    // 自分の記録（入らなかったときは、今載っている自分の順位を返す）
    const mine=l=>v.dh?(l.find(e=>e.dh===v.dh)||{}).id:null;
    let id=null;
    if(pA||pD){
      const e=Object.assign({id:crypto.randomUUID().slice(0,8),t:Date.now()},v);delete e.m;delete e.day;id=e.id;
      const add=(l,p)=>{if(p.i>=0)l.splice(p.i,1);l.push(e);l.sort((a,b)=>M.dir*(b.s-a.s)||a.t-b.t);l.length=Math.min(l.length,KEEP);};
      const w={};
      if(pA){add(L.all,pA);w['all:'+v.m]=L.all;}
      if(pD){add(L.day,pD);w['day:'+v.m]={d:L.today,l:L.day};}
      await this.ctx.storage.put(w);
    }
    const out=await this.view();
    return Object.assign(out,{m:v.m,id,best:[pA,pD].some(p=>p&&p.i>=0),pos:posOf(L.all,pA?id:mine(L.all)),dpos:posOf(L.day,pD?id:mine(L.day))});
  }
  // 1回の遊びを数える。同じ eid の送り直しは数えない
  async play(first,eid,L){
    const d=jstDay(Date.now()),s=this.ctx.storage,row=[eid,Date.now(),L.ver,first?1:0,L.mode,L.why,L.m,L.secs,L.clear,L.n,L.e1,L.e2,L.src,L.ext,L.stage];
    const c=s.sql.exec(`INSERT OR IGNORE INTO plays_log(${LOG_COLS.join(',')}) VALUES(${LOG_COLS.map(()=>'?').join(',')})`,...row);
    c.toArray();if(!c.rowsWritten)return {ok:true,dup:true};
    const k=['plays','plays:'+d].concat(first?['players','players:'+d]:[]),cur=await s.get(k),o={};
    for(const x of k)o[x]=(cur.get(x)||0)+1;
    await s.put(o);
    if(o.plays%500===0)s.sql.exec(`DELETE FROM plays_log WHERE rowid<=(SELECT MAX(rowid) FROM plays_log)-?`,LOG_KEEP);   // 増えすぎた古い分を消す
    return {ok:true};
  }
  async stats(days){
    const s=this.ctx.storage,now=Date.now(),ks=['plays','players'],rows=[];
    for(let i=0;i<days;i++){const d=jstDay(now-i*86400e3);rows.push(d);ks.push('plays:'+d,'players:'+d);}
    const m=await s.get(ks);
    return {plays:m.get('plays')||0,players:m.get('players')||0,days:rows.map(d=>({d,plays:m.get('plays:'+d)||0,players:m.get('players:'+d)||0}))};
  }
  // 集計（plays… と players… で始まる値）と記録を消す。ランキングは残す
  //   seq はリセットのボタンに持たせた1回きりの番号。画面の再読み込みでフォームが送り直されても、同じ番号では2度目を消さない（-1 を返す）
  async resetSeq(){return (await this.ctx.storage.get('rseq'))||0;}
  async resetStats(seq){
    const s=this.ctx.storage,cur=(await s.get('rseq'))||0;
    if(seq!==cur)return -1;
    await s.put({rseq:cur+1});
    const ks=[];
    for(const p of ['plays','players'])ks.push(...(await s.list({prefix:p})).keys());
    for(let i=0;i<ks.length;i+=128)await s.delete(ks.slice(i,i+128));
    s.sql.exec('DELETE FROM plays_log');
    return ks.length;
  }
  // 調整用の分析（直近2万件。ver を渡すとその版だけ）
  analyze(ver){
    const all=this.ctx.storage.sql.exec(`SELECT ver,mode,why,m,secs,clear,n,e1,e2,src,ext,stage FROM plays_log ORDER BY rowid DESC LIMIT 20000`).toArray();
    const vc={};for(const r of all){const v=r.ver||'?';vc[v]=(vc[v]||0)+1;}
    const rows=ver?all.filter(r=>(r.ver||'?')===ver):all;
    const med=a=>{if(!a.length)return null;a=a.slice().sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
    const p90=a=>{if(!a.length)return null;a=a.slice().sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor(a.length*0.9))];};
    // まとまりごとに：回数・30秒の高さ（中央値・上位10%・最高）・1000mのゴール率と秒の中央値・途中でやめた割合
    const sum=list=>{
      const t30=list.filter(r=>r.mode==='time30'&&r.why!=='quit').map(r=>r.m||0),ta=list.filter(r=>r.mode==='ta1000'),tac=ta.filter(r=>r.clear);
      return {n:list.length,t30:t30.length,med:med(t30),p90:p90(t30),max:t30.length?Math.max(...t30):null,ta:ta.length,goal:tac.length,tamed:med(tac.map(r=>r.secs||0)),quit:list.filter(r=>r.why==='quit').length};
    };
    const game=rows.filter(r=>r.mode!=='tut');
    const by=(f,keys)=>{const g=new Map();for(const r of game){for(const k of [].concat(f(r)))if(k!==null&&k!==undefined){if(!g.has(k))g.set(k,[]);g.get(k).push(r);}}
      return [...g.entries()].filter(([k])=>!keys||keys.includes(k)).map(([k,l])=>Object.assign({k},sum(l))).sort((a,b)=>b.n-a.n);};
    const why={};for(const r of game)if(r.why)why[r.why]=(why[r.why]||0)+1;
    const sizeK=r=>r.ext===null||r.ext===undefined?null:r.ext<120?'〜119':r.ext<180?'120〜179':r.ext<240?'180〜239':'240〜';
    const tut=[0,1,2].map(i=>{const l=rows.filter(r=>r.mode==='tut'&&r.stage===i);return {i,n:l.length,goal:l.filter(r=>r.why==='goal').length,quit:l.filter(r=>r.why==='quit').length,miss:l.filter(r=>r.why&&r.why!=='goal'&&r.why!=='quit').length};});
    return {vers:Object.entries(vc).sort((a,b)=>b[0].localeCompare(a[0],undefined,{numeric:true})),n:rows.length,all:sum(game),why,
      modes:by(r=>r.mode),shapes:by(r=>r.n),effects:by(r=>[r.e1,r.e2]),combos:by(r=>r.e1&&r.e2?[r.e1,r.e2].sort().join('+'):null),src:by(r=>r.src),size:by(sizeK),tut};
  }
  // CSV（新しい順に最大5万件）
  csv(){
    const rows=this.ctx.storage.sql.exec(`SELECT ${LOG_COLS.slice(1).join(',')} FROM plays_log ORDER BY rowid DESC LIMIT 50000`).toArray();
    const cell=x=>x===null||x===undefined?'':(typeof x==='string'&&/[",\n]/.test(x)?'"'+x.replace(/"/g,'""')+'"':String(x));
    const head=LOG_COLS.slice(1);
    return [head.join(',')].concat(rows.map(r=>head.map(h=>h==='t'?cell(new Date(r.t+9*3600e3).toISOString().slice(0,19).replace('T',' ')):cell(r[h])).join(','))).join('\r\n');
  }
  async remove(id){
    const s=this.ctx.storage,w={};let hit=0;
    for(const m of Object.keys(MODES)){
      const L=await this.lists(m),a=L.all.filter(e=>e.id!==id),d=L.day.filter(e=>e.id!==id);
      if(a.length!==L.all.length){w['all:'+m]=a;hit++;}
      if(d.length!==L.day.length){w['day:'+m]={d:L.today,l:d};hit++;}
    }
    if(hit)await s.put(w);
    return hit>0;
  }
}
const board=env=>env.BOARD.get(env.BOARD.idFromName('main'));

// 同じ端末（IP）からの連投を止める（秒）。IP は短い時間だけキャッシュに置き、保存はしない
const rateKey=(req,tag)=>new Request('https://rate.local/'+tag+'/'+encodeURIComponent(req.headers.get('cf-connecting-ip')||''));
const hasIp=req=>!!req.headers.get('cf-connecting-ip');
async function rateHas(req,tag){return hasIp(req)&&!!(await caches.default.match(rateKey(req,tag)));}
async function rateMark(req,tag,sec){if(hasIp(req))await caches.default.put(rateKey(req,tag),new Response('1',{headers:{'cache-control':'max-age='+sec}}));}
async function busy(req,tag,sec){if(await rateHas(req,tag))return true;await rateMark(req,tag,sec);return false;}
// 回数で止める：同じ IP から sec 秒の間に max 回まで。スマホ回線や Wi-Fi は1つの IP を大勢で使うので、間隔ではなく回数で見る
async function tooMany(req,tag,max,sec){if(!hasIp(req))return false;const k=rateKey(req,tag),r=await caches.default.match(k),n=r?(+(await r.text())||0):0;if(n>=max)return true;await caches.default.put(k,new Response(String(n+1),{headers:{'cache-control':'max-age='+sec}}));return false;}

async function rank(req,env){
  if(req.method==='GET'){try{return json(await board(env).view());}catch(e){return json({error:'server',err:errText(e)},500);}}
  if(req.method!=='POST')return json({error:'method'},405);
  if(await busy(req,'rank',8))return json({error:'busy'},429);
  let b;try{b=await req.json();}catch(e){return json({error:'bad'},400);}
  const v=valid(b);if(!v)return json({error:'invalid'},400);
  const dh=await devHash(b.d);if(!dh)return json({error:'invalid'},400);   // 端末番号が無いと1端末1件にできないので受け付けない
  v.dh=dh;
  const now=Date.now(),at=typeof b.at==='number'&&isFinite(b.at)?Math.min(b.at,now):now;v.day=jstDay(at)===jstDay(now);
  try{return json(await board(env).submit(v));}catch(e){return json({error:'server',err:errText(e)},500);}
}

async function play(req,env){
  if(req.method!=='POST')return json({error:'method'},405);
  if(await tooMany(req,'play',60,60))return json({ok:false},429);   // 同じ IP から1分に60回をこえる分は数えない（同じ回線のほかの人は止めない）
  let b={};try{b=await req.json();}catch(e){}
  b=b&&typeof b==='object'?b:{};
  const eid=typeof b.e==='string'&&/^[0-9a-f]{16,32}$/.test(b.e)?b.e:'',L=cleanLog(b.l,b.v);
  if(!eid||!L||!L.mode)return json({error:'invalid'},400);
  try{return json(await board(env).play(b.f===1,eid,L));}catch(e){return json({error:'server',err:errText(e)},500);}
}

// ---- 消すためのページ（合言葉が要る） ----
async function keyOk(given,env){   // 長さや一致した文字数で時間が変わらないように比べる
  const want=env.ADMIN_KEY;if(typeof want!=='string'||!want||typeof given!=='string')return false;
  const h=async x=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)));
  const a=await h(given),b=await h(want);let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0;
}
async function admin(req,env){
  if(req.method==='GET')return Response.redirect(new URL('/stats',req.url).toString(),302);   // 管理は集計ページで
  if(req.method!=='POST')return json({error:'method'},405);
  if(await busy(req,'admin',1))return json({error:'busy'},429);   // 合言葉の総当たりを遅くする
  let b;try{b=await req.json();}catch(e){return json({error:'bad'},400);}
  if(!(await keyOk(b&&b.k,env)))return json({error:'key'},403);
  if(b.a==='list')return json(await board(env).view());
  if(b.a==='del'&&typeof b.id==='string')return json({ok:await board(env).remove(b.id)});
  return json({error:'bad'},400);
}

// ---- 集計ページ（合言葉が要る）。ろくろと同じく、フォームで送ってサーバーで組み立てる ----
const esc=t=>String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const EFF_WORD={bounce:'バウンド',swing:'スイング',kick:'カベけり',stab:'ザクザク',high:'ハイジャンプ',glide:'ふわり',air:'空中ジャンプ',big:'大ジャンプ'};
const WHY_WORD={time:'タイムアップ',goal:'ゴール',tide:'おいつかれた',enemy:'ぶつかった',spike:'トゲ',quit:'途中でやめた'};
const MODE_WORD={time30:'30秒アタック',ta1000:'1000m',normal:'エンドレス',tut:'チュートリアル'};
const CSS=`body{margin:0;padding:16px;background:#eaf6ff;color:#1d2440;font-family:system-ui,"Hiragino Sans","Yu Gothic UI",sans-serif}h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:28px 0 8px}h3{font-size:14px;margin:16px 0 4px}
.t{display:flex;flex-wrap:wrap;gap:24px;margin-bottom:16px}.t b{display:block;font-size:28px}table{border-collapse:collapse;width:100%;max-width:720px;font-variant-numeric:tabular-nums}
td,th{border-bottom:1px solid rgba(29,36,64,.16);padding:6px 4px;text-align:right;vertical-align:middle}td:first-child,th:first-child{text-align:left}small{color:#5b6585}
.m{margin:0 0 12px}.m.ng{color:#d23a6c}td.l{text-align:left}td small{display:block}
form{display:flex;gap:8px;max-width:480px;margin:0}form.k{margin-top:8px}form input,form select{flex:1;min-width:0;font:inherit;padding:8px;border:1px solid rgba(29,36,64,.3);background:#fff;border-radius:0}
button{font:inherit;font-weight:700;padding:8px 14px;border:0;background:#1d2440;color:#fff;border-radius:0;cursor:pointer}td button{padding:4px 10px;font-size:13px;background:#d23a6c}
table.an th,table.an td{white-space:nowrap;font-size:12px;padding:5px 5px}.sc{overflow-x:auto}`;
const page=body=>new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>集計｜おえかきジャンプ</title><style>${CSS}</style></head><body>
<h1>おえかきジャンプ 集計</h1>${body}</body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer','x-robots-tag':'noindex'}});
const MSG={ok:'集計を0に戻しました。',again:'リセットは もう済んでいます（画面の再読み込みでは、もう一度は消しません）。',del:'ランキングから1件消しました。',gone:'その記録はもうランキングにありません。',ng:'合言葉が違います。',busy:'少し待ってからもう一度入れてください。',switch:'更新の切り替え中です。1〜2分たってから、もう一度開いてください。',nokey:'合言葉（ADMIN_KEY）が Cloudflare に登録されていません。'};
const msgHtml=r=>MSG[r]?`<p class="m${['ok','del','again'].includes(r)?'':' ng'}">${MSG[r]}</p>`:'';
const loginPage=r=>page(`${msgHtml(r)}<form method="post" action="/stats"><input type="password" name="k" placeholder="合言葉" autocomplete="current-password" required autofocus><input type="hidden" name="a" value="view"><button>開く</button></form>`);
const pct=(a,b)=>b?Math.round(a/b*100)+'%':'-';
const nv=x=>x===null||x===undefined?'-':String(x);
// 分析の表：まとまりごとの回数と成績
function anTable(title,list,word,note){
  const tr=list.map(x=>`<tr><td>${esc(word?word(x.k):x.k)}</td><td>${x.n}</td><td>${x.t30}</td><td>${nv(x.med)}</td><td>${nv(x.p90)}</td><td>${nv(x.max)}</td><td>${x.ta}</td><td>${pct(x.goal,x.ta)}</td><td>${x.tamed===null?'-':x.tamed.toFixed(1)}</td><td>${pct(x.quit,x.n)}</td></tr>`).join('');
  return `<h3>${title}</h3><div class="sc"><table class="an"><tr><th></th><th>回数</th><th>30秒</th><th>中央値m</th><th>上位10%</th><th>最高</th><th>1000m</th><th>ゴール率</th><th>秒の中央値</th><th>やめた</th></tr>${tr||'<tr><td>まだありません</td></tr>'}</table></div>${note?`<p><small>${note}</small></p>`:''}`;
}
function analysisHtml(A,ver,hk){
  const opt=['<option value="">すべての版</option>'].concat(A.vers.map(([v,c])=>`<option value="${esc(v)}"${v===ver?' selected':''}>ver. ${esc(v)}（${c}回）</option>`)).join('');
  const why=Object.entries(A.why).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${WHY_WORD[k]||k} ${n}`).join('・');
  const tut=A.tut.map(x=>`<tr><td>${['まる（バウンド）','かぎ（スイング）','しかく（カベけり）'][x.i]}</td><td>${x.n}</td><td>${x.goal}</td><td>${x.miss}</td><td>${x.quit}</td></tr>`).join('');
  const effW=k=>k.split('+').map(x=>EFF_WORD[x]||x).join('×');
  return `<h2>分析（直近${A.n.toLocaleString()}回）</h2>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="view"><select name="ver">${opt}</select><button>絞り込む</button></form>
<p><small>終わったわけ：${esc(why)||'-'}</small></p>
${anTable('モード別',A.modes,k=>MODE_WORD[k]||k)}
${anTable('形の名前別',A.shapes)}
${anTable('特殊効果別（2つのどちらかに持っている）',A.effects,k=>EFF_WORD[k]||k)}
${anTable('特殊効果の組み合わせ別',A.combos,effW)}
${anTable('見本か自作か',A.src,k=>k==='tpl'?'見本そのまま':'自分で描いた')}
${anTable('描いた大きさ別（描く枠は300）',A.size,null,'大きさ＝描いた絵の縦か横の長い方。キャラの大きさはこれに比例する。')}
<h3>チュートリアル</h3><div class="sc"><table class="an"><tr><th>段</th><th>回数</th><th>旗に着いた</th><th>失敗</th><th>やめた</th></tr>${tut}</table></div>
<p><small>「旗に着いた」には、主役の効果を使わずに着いてやり直しになった回も入る。</small></p>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="csv"><button>記録を CSV で保存（直近5万件）</button></form>`;
}
async function stats(req,env){
  if(req.method==='GET')return loginPage('');
  if(req.method!=='POST')return json({error:'method'},405);
  let f=null;try{f=await req.formData();}catch(e){}
  const k=String(f&&f.get('k')||''),a=String(f&&f.get('a')||'view'),id=String(f&&f.get('id')||'');
  const ver=/^(\d{1,3}\.\d{1,3}\.\d{1,3}|\?)$/.test(String(f&&f.get('ver')||''))?String(f.get('ver')):'';
  if(!env.ADMIN_KEY)return loginPage('nokey');
  // 合言葉の総当たりを防ぐ：間違えたら、同じ端末からは5秒待たないと次を試せない
  if(await rateHas(req,'statsng'))return loginPage('busy');
  if(!(await keyOk(k,env))){await rateMark(req,'statsng',5);return loginPage('ng');}
  if(a==='csv'){
    try{return new Response('\ufeff'+await board(env).csv(),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="oekaki_jump_plays.csv"','cache-control':'no-store'}});}
    catch(e){return loginPage('switch');}
  }
  const rs=Number(f&&f.get('rs'));
  try{return await statsBody(env,k,a,id,ver,rs);}catch(e){return loginPage('switch');}   // 公開し直した直後は、保存先だけ古い版のことがある
}
async function statsBody(env,k,a,id,ver,rs){
  const b=board(env);let r='';
  if(a==='reset')r=(await b.resetStats(rs))<0?'again':'ok';
  else if(a==='del'&&/^[0-9a-f]{8}$/.test(id))r=(await b.remove(id))?'del':'gone';
  const st=await b.stats(30),view=await b.view(),an=b.analyze(ver),A=await an;
  const hk=`<input type="hidden" name="k" value="${esc(k)}">`;
  const tr=st.days.map(x=>`<tr><td>${x.d}</td><td>${x.plays.toLocaleString()}</td><td>${x.players.toLocaleString()}</td></tr>`).join('');
  // ランキング：全期間と今日をまとめて1件ずつ、どこに載っているかを添える
  const seen=new Map();
  for(const m of Object.keys(MODES))for(const w of ['all','day'])view[m][w].forEach((e,i)=>{const x=seen.get(e.id)||{e,m,tags:[]};x.tags.push((w==='all'?'全期間':'今日')+' '+(i+1)+'位');seen.set(e.id,x);});
  const rows=[...seen.values()].sort((x,y)=>x.m.localeCompare(y.m)||MODES[x.m].dir*(y.e.s-x.e.s));
  const rk=rows.map(({e,m,tags})=>{const d=new Date(e.t+9*3600e3);return `<tr><td class="l">${esc(e.u||'ななし')}<small>${esc(MODE_WORD[m])}　${esc(e.n)}　${esc(e.e.map(x=>EFF_WORD[x]||x).join('×'))}　${d.getUTCMonth()+1}/${d.getUTCDate()}　${esc(tags.join('・'))}</small></td><td>${m==='ta1000'?e.s.toFixed(2)+'秒':e.s+'m'}</td>
<td><form method="post" action="/stats" onsubmit="return confirm('この記録をランキングから消します。よろしいですか？')">${hk}<input type="hidden" name="a" value="del"><input type="hidden" name="id" value="${esc(e.id)}"><button>消す</button></form></td></tr>`;}).join('');
  return page(`${msgHtml(r)}
<div class="t"><div>プレイ回数<b>${st.plays.toLocaleString()}</b></div><div>プレイした人<b>${st.players.toLocaleString()}</b></div><div>ランキング登録<b>${rows.length.toLocaleString()}</b></div></div>
<table><tr><th>日付（日本時間）</th><th>回数</th><th>新しい人</th></tr>${tr}</table>
<p><small>回数は、遊び終わった回（チュートリアルの各段・途中でやめた回も入る）。人数は「その端末で初めて遊んだ回」を数えたもの。ブラウザの記録を消すと、同じ人でも新しい人として数え直されます。</small></p>
<form class="k" method="post" action="/stats" onsubmit="return confirm('プレイ回数・人数・記録を0に戻します（ランキングは消えません）。よろしいですか？')">${hk}<input type="hidden" name="a" value="reset"><input type="hidden" name="rs" value="${await b.resetSeq()}"><button>集計をリセット</button></form>
${analysisHtml(A,ver,hk)}
<h2>ランキングの記録（${rows.length}件）</h2>
<table>${rk||'<tr><td>まだ記録がありません</td></tr>'}</table>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="view"><button>最新にする</button></form>`);
}

export default {
  async fetch(req,env){
    const p=new URL(req.url).pathname;
    if(p==='/api/rank')return rank(req,env);
    if(p==='/api/play')return play(req,env);
    if(p==='/stats')return stats(req,env);
    if(p==='/admin')return admin(req,env);
    return env.ASSETS.fetch(req);
  }
};
