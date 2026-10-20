// おえかきジャンプ：ランキングの API。それ以外のパスは静的ファイル（index.html など）をそのまま返す
//   GET  /api/rank              → {time30:{all:[…],day:[…]}, ta1000:{all:[…],day:[…]}, day:'YYYY-MM-DD'}
//                                  1件は {id,u,s,n,e,t}（u なまえ、s 記録、n 形の名前、e 特殊効果の id、t 登録時刻）
//   POST /api/rank {m,s,u,n,e,d} → 中身を検証し、全期間か今日の上位に入れば保存して {pos,dpos,id,best,…上と同じ一覧}
//                                  m は time30（s＝高さ m・多いほど上）か ta1000（s＝秒・少ないほど上）
//                                  d は端末番号。各一覧に1端末1件（自己ベストだけ）。より良い記録なら入れ替えて best=true
//   GET  /admin                  → 合言葉の入力欄（ランキングの1件を消す）
//   POST /admin {k,a,id,m}       → 合言葉が合えば、a=list で全件、a=del で id の1件を消す
//                                  合言葉は Cloudflare の Secret「ADMIN_KEY」に登録する（コードには書かない。未登録なら使えない）
// 保存先は Durable Object（SQLite、無料プランで使える）1つ。描いた絵は受け取らない
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
    const pA=plan(L.all),pD=plan(L.day),posOf=(l,id)=>{const i=id?l.findIndex(x=>x.id===id):-1;return i>=0?i+1:null;};
    // 自分の記録（入らなかったときは、今載っている自分の順位を返す）
    const mine=l=>v.dh?(l.find(e=>e.dh===v.dh)||{}).id:null;
    let id=null;
    if(pA||pD){
      const e=Object.assign({id:crypto.randomUUID().slice(0,8),t:Date.now()},v);delete e.m;id=e.id;
      const add=(l,p)=>{if(p.i>=0)l.splice(p.i,1);l.push(e);l.sort((a,b)=>M.dir*(b.s-a.s)||a.t-b.t);l.length=Math.min(l.length,KEEP);};
      const w={};
      if(pA){add(L.all,pA);w['all:'+v.m]=L.all;}
      if(pD){add(L.day,pD);w['day:'+v.m]={d:L.today,l:L.day};}
      await this.ctx.storage.put(w);
    }
    const out=await this.view();
    return Object.assign(out,{m:v.m,id,best:[pA,pD].some(p=>p&&p.i>=0),pos:posOf(L.all,pA?id:mine(L.all)),dpos:posOf(L.day,pD?id:mine(L.day))});
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
async function busy(req,tag,sec){
  if(!req.headers.get('cf-connecting-ip'))return false;
  if(await caches.default.match(rateKey(req,tag)))return true;
  await caches.default.put(rateKey(req,tag),new Response('1',{headers:{'cache-control':'max-age='+sec}}));return false;
}

async function rank(req,env){
  if(req.method==='GET'){try{return json(await board(env).view());}catch(e){return json({error:'server',err:errText(e)},500);}}
  if(req.method!=='POST')return json({error:'method'},405);
  if(await busy(req,'rank',8))return json({error:'busy'},429);
  let b;try{b=await req.json();}catch(e){return json({error:'bad'},400);}
  const v=valid(b);if(!v)return json({error:'invalid'},400);
  const dh=await devHash(b.d);if(dh)v.dh=dh;
  try{return json(await board(env).submit(v));}catch(e){return json({error:'server',err:errText(e)},500);}
}

// ---- 消すためのページ（合言葉が要る） ----
async function keyOk(given,env){   // 長さや一致した文字数で時間が変わらないように比べる
  const want=env.ADMIN_KEY;if(typeof want!=='string'||!want||typeof given!=='string')return false;
  const h=async x=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)));
  const a=await h(given),b=await h(want);let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0;
}
const ADMIN_HTML=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ランキングの管理</title>
<style>body{font-family:sans-serif;margin:16px;max-width:640px}input,button{font-size:16px;padding:6px}li{margin:4px 0}button.d{margin-left:8px}</style>
<h1>ランキングの管理</h1><p><input id="k" type="password" placeholder="合言葉"> <button id="go">表示</button></p><div id="o"></div>
<script>
const k=document.getElementById('k'),o=document.getElementById('o');
async function post(b){const r=await fetch('/admin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({k:k.value},b))});return r.json();}
async function load(){const r=await post({a:'list'});if(r.error){o.textContent='合言葉がちがいます';return;}o.innerHTML='';
for(const m of ['time30','ta1000'])for(const w of ['all','day']){const h=document.createElement('h3');h.textContent=m+' / '+(w==='all'?'全期間':'今日');o.append(h);const ul=document.createElement('ol');
for(const e of r[m][w]){const li=document.createElement('li');li.textContent=(e.u||'ななし')+'　'+e.s+'　'+e.n;const b=document.createElement('button');b.className='d';b.textContent='消す';
b.onclick=async()=>{if(!confirm((e.u||'ななし')+' を消しますか'))return;await post({a:'del',id:e.id});setTimeout(load,1500);};li.append(b);ul.append(li);}o.append(ul);}}
document.getElementById('go').onclick=load;
</script>`;
async function admin(req,env){
  if(req.method==='GET')return new Response(ADMIN_HTML,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-robots-tag':'noindex'}});
  if(req.method!=='POST')return json({error:'method'},405);
  if(await busy(req,'admin',1))return json({error:'busy'},429);   // 合言葉の総当たりを遅くする
  let b;try{b=await req.json();}catch(e){return json({error:'bad'},400);}
  if(!(await keyOk(b&&b.k,env)))return json({error:'key'},403);
  if(b.a==='list')return json(await board(env).view());
  if(b.a==='del'&&typeof b.id==='string')return json({ok:await board(env).remove(b.id)});
  return json({error:'bad'},400);
}

export default {
  async fetch(req,env){
    const p=new URL(req.url).pathname;
    if(p==='/api/rank')return rank(req,env);
    if(p==='/admin')return admin(req,env);
    return env.ASSETS.fetch(req);
  }
};
