/* cbp_validator.js - Circuit Builder Pro validation engine.
   No drawing code. Loaded on demand by the Validate button in CBP_Sabbir.html.
   Reads the circuit as data, builds nets, runs static checks, then dry-runs the
   control logic (all button/switch combinations, with memory such as seal-in). */
(function(){
'use strict';
const key=l=>((l||'').trim().toUpperCase().split(/[\s(\/:,]+/)[0])||'';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const PROT=['mcb','mccb','acb','vcb','sf6','elcb','rccb','rcbo'];
const ACT=['solenoid','shunt_trip','uv_trip','brake_coil'];
const MAXS=30000;

function run(api){
 const t0=performance.now(),out=[],SYM=api.SYM,cs=api.components.filter(c=>SYM[c.symbolId]);
 const nm=c=>(c.label&&c.label.trim())||SYM[c.symbolId].name+' #'+c.uid;
 const add=(sev,id,title,why,fix,uids,x)=>out.push(Object.assign({sev,id,title,why,fix,uids:uids||[]},x||{}));
 const par=new Map(),f=x=>{if(!par.has(x))par.set(x,x);let r=x;while(par.get(r)!==r)r=par.get(r);while(par.get(x)!==r){const n=par.get(x);par.set(x,r);x=n}return r},un=(a,b)=>par.set(f(a),f(b));
 const pk=(u,p)=>u+':'+p,near=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<2;
 const segHit=(p,pts)=>{for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i],dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy||1,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l));if(Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<2)return true}return false};

 /* ---------- 1. nets ---------- */
 const PW=new Map(cs.map(c=>[c.uid,api.portsWorld(c)])),used=new Set();
 cs.forEach(c=>{const k=SYM[c.symbolId].kind;if(k==='basicMisc'||k==='bus'){const p=PW.get(c.uid);p.forEach(q=>un(pk(c.uid,p[0].id),pk(c.uid,q.id)))}});
 const WS=api.wires.map(w=>({w,pts:api.wirePts(w),id:'w'+w.uid}));
 WS.forEach(o=>{f(o.id);o.w.pts.forEach(p=>{if(p.ref&&PW.has(p.ref.uid)){const k=pk(p.ref.uid,p.ref.port);un(o.id,k);used.add(k)}})});
 const dangling=[];
 WS.forEach(o=>[0,o.pts.length-1].forEach(i=>{
  const p=o.pts[i],r=o.w.pts[i];if(!p||(r&&r.ref&&PW.has(r.ref.uid)))return;
  let hit=false;
  cs.forEach(c=>PW.get(c.uid).forEach(q=>{if(near(p,q)){un(o.id,pk(c.uid,q.id));used.add(pk(c.uid,q.id));hit=true}}));
  WS.forEach(o2=>{if(o2!==o)o2.pts.forEach(q=>{if(near(p,q)){un(o.id,o2.id);hit=true}})});
  if(!hit)dangling.push({x:p.x,y:p.y,seg:WS.some(o2=>o2!==o&&segHit(p,o2.pts))});
 }));
 const ids=new Map(),N=k=>{const r=f(k);if(!ids.has(r))ids.set(r,ids.size);return ids.get(r)};

 /* ---------- 2. elements ---------- */
 const EL=[],INP=[],COIL=[],SRC=[],EARTH=[],MOT=[],inpOf=new Map();
 cs.forEach(c=>{
  const s=SYM[c.symbolId],k=s.kind,pid=PW.get(c.uid).map(q=>q.id),L=key(c.label);
  const pl=()=>pid.includes('a1')?pid.filter(i=>/^a\d+$/.test(i)).map(a=>[a,'b'+a.slice(1),+a.slice(1)]):[['a','b',0]];
  const E=(a,b,t,o)=>EL.push(Object.assign({c,s,na:N(pk(c.uid,a)),nb:N(pk(c.uid,b)),t,pole:0},o||{}));
  const es=(k==='pb'&&s.variant==='estop')||(k==='ctl'&&s.head==='emerg');
  const inp=(a,b,mode)=>{let i=inpOf.get(c.uid);if(i===undefined){i=INP.length;inpOf.set(c.uid,i);INP.push({c,name:nm(c),estop:es})}E(a,b,'inp',{i,mode})};
  const ab=pid.includes('a')&&pid.includes('b'),bk=s.bkind;
  if(k==='source'||k==='battery'){if(ab)SRC.push({c,na:N(pk(c.uid,'a')),nb:N(pk(c.uid,'b'))})}
  else if(k==='earth')EARTH.push(N(pk(c.uid,'a')));
  else if(k==='motorX'||k==='load3ph')MOT.push({c,nets:pid.map(i=>N(pk(c.uid,i)))});
  else if(k==='fuseN'||k==='ovl')pl().forEach(p=>E(p[0],p[1],'zi',{prot:1,pole:p[2]}));
  else if(k==='resV')pl().forEach(p=>E(p[0],p[1],'imp',{pole:p[2]}));
  else if((k==='ovlEl'||k==='xfmr'||(k==='passive'&&/resistor|inductor|reactor/.test(s.variant))||(k==='powerElec'&&!/igbt|mosfet/.test(s.id)))&&ab)E('a','b','imp');
  else if(k==='semiconductor'&&s.variant!=='thyristor')E('a','b','dir',{semi:s.variant});
  else if(k==='coil'||k==='coilV'){E('a','b','coil',{key:L||'#'+c.uid});COIL.push({c,s,key:L||'#'+c.uid,idx:EL.length-1})}
  else if(k==='contact'){if(s.variant==='spdt'){E('com','no','ctc',{key:L,mode:'no'});E('com','nc','ctc',{key:L,mode:'nc'})}else E('a','b','ctc',{key:L,mode:s.variant})}
  else if(k==='contact3ph')pl().forEach(p=>E(p[0],p[1],'ctc',{key:L,mode:s.variant,pole:p[2],pw:1}));
  else if(k==='iec')pl().forEach(p=>s.mark==='ctr'?E(p[0],p[1],'ctc',{key:L,mode:'no',pole:p[2],pw:1,prot:!!s.trip}):E(p[0],p[1],'zi',{prot:s.mark==='cb'||!!s.trip,pole:p[2]}));
  else if(k==='ctl'){if(s.form==='co'){inp('com','nc','nc');inp('com','no','no')}else if(s.form==='x'){inp('a1','b1','nc');inp('a2','b2','no')}else inp('a','b',s.form)}
  else if(k==='pb')inp('a','b',/nc|estop/.test(s.variant)?'nc':'no');
  else if(k==='fieldSwitch')inp('a','b','no');
  else if(k==='breaker'){if(bk==='switch')inp('a','b','no');else if(bk==='ol')inp('a','b','nc');else if(!['earth_sw','spd','arrester','ef'].includes(bk)&&ab)E('a','b','zi',{prot:PROT.includes(bk)})}
 });
 const NN=ids.size;

 /* ---------- 3. static checks ---------- */
 dangling.forEach(d=>add('warn','S01','Wire end not connected',d.seg?'This wire ends on the side of another wire, not on a point of it, so the two are not joined electrically.':'This wire end is not attached to any terminal or wire.',d.seg?'End the wire on a vertex of the other wire (add a junction dot there), or on a terminal.':'Drag the end onto a terminal or delete the stray wire.',[],{pos:{x:d.x,y:d.y}}));
 cs.forEach(c=>{
  const s=SYM[c.symbolId],pid=PW.get(c.uid).map(q=>q.id),open=pid.filter(i=>!used.has(pk(c.uid,i)));
  if(s.kind==='basicMisc'||!pid.length)return;
  if(open.length===pid.length)add('info','S02','Isolated component: '+nm(c),'It has no wire on any terminal, so it takes no part in the circuit.','Wire it in or delete it.',[c.uid]);
  else if(open.length&&!((s.ports==='spdt'||s.ports==='co_v')&&pid.length-open.length>=2))add('warn','S03','Open terminal on '+nm(c),'Terminal(s) '+open.join(', ')+' have no wire. An unused pole or terminal can leave a phase or return path open.','Connect the terminal, or ignore if it is intentionally spare.',[c.uid]);
 });
 const seen=new Map();cs.forEach(c=>{const k=c.symbolId+'@'+c.x+','+c.y;if(seen.has(k))add('warn','S04','Duplicate component on top of another: '+nm(c),'Two identical symbols sit at the same position, so a wire may attach to the wrong one.','Delete the duplicate.',[c.uid,seen.get(k)]);else seen.set(k,c.uid)});
 const ss=new Set();SRC.forEach((s,j)=>{if(s.na===s.nb){ss.add(j);add('error','S05','Source shorted: '+nm(s.c),'Both terminals of this source are on the same net, so it is short-circuited permanently.','Remove the wire joining the two terminals.',[s.c.uid])}});
 EL.forEach(e=>{if((e.t==='coil'||e.t==='imp'||e.t==='dir')&&e.na===e.nb)add('warn','S06','Component bypassed: '+nm(e.c),'Both terminals are on the same net, so current skips this component entirely.','Check the wiring at this component.',[e.c.uid])});
 if(SRC.length&&!EARTH.length)add('warn','S07','No earth or PE in the circuit','Sources are present but there is no earth symbol, so there is no protective earth or reference.','Add PE/earth and bond frames, the neutral and the surge devices.',[]);
 if(!SRC.length)add('info','S08','No source found','Without a supply symbol, no supply-dependent check can run.','Add an AC/DC supply, generator, battery or PV panel.',[]);
 /* protection reach */
 const reach=(skipProt)=>{const adj=[];EL.forEach(e=>{if(e.t==='coil'||(skipProt&&e.prot))return;(adj[e.na]=adj[e.na]||[]).push(e.nb);if(e.t!=='dir')(adj[e.nb]=adj[e.nb]||[]).push(e.na)});const R=new Set(),q=[];SRC.forEach(s=>[s.na,s.nb].forEach(n=>{R.add(n);q.push(n)}));while(q.length){const x=q.pop();(adj[x]||[]).forEach(y=>{if(!R.has(y)){R.add(y);q.push(y)}})}return R};
 if(SRC.length&&MOT.length){const A=reach(false),P=reach(true);MOT.forEach(m=>{if(!m.nets.some(n=>A.has(n)))add('warn','S09','No supply path to '+nm(m.c),'No chain of wires, switches and devices connects this load to any source.','Check the feeder wiring and that no wire end is left open.',[m.c.uid]);else if(m.nets.some(n=>P.has(n)))add('warn','S10','Unprotected feeder to '+nm(m.c),'A route from the source reaches this load without passing a fuse, breaker or overload.','Add short-circuit protection (fuse/MCCB) and, for motors, an overload in every route.',[m.c.uid])})}
 /* electronics: diode/LED straight across a source */
 if(SRC.length){const p=[];for(let i=0;i<NN;i++)p[i]=i;const g=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x]}return x};EL.forEach(e=>{if(e.t==='zi')p[g(e.na)]=g(e.nb)});
  EL.forEach(e=>{if(e.t==='dir'&&SRC.some(s=>(g(e.na)===g(s.na)&&g(e.nb)===g(s.nb))||(g(e.na)===g(s.nb)&&g(e.nb)===g(s.na))))add(e.semi==='led'?'warn':'error','E01',(e.semi==='led'?'LED':'Diode')+' connected directly across the supply: '+nm(e.c),e.semi==='led'?'An LED needs a series resistor; with none it will draw excessive current and fail.':'With no series impedance the diode forward-conducts into the source: a short circuit.','Add a series resistor (LED) or the intended load (diode).',[e.c.uid])})}

 /* ---------- 4. control-logic labels ---------- */
 const keys=[...new Set(COIL.map(x=>x.key))],KI=new Map(keys.map((k,i)=>[k,i]));
 const cnt=new Map();COIL.forEach(x=>cnt.set(x.key,(cnt.get(x.key)||[]).concat(x.c.uid)));
 cnt.forEach((u,k)=>{if(u.length>1&&k[0]!=='#')add('warn','C01','Two coils share the label '+k,'Contacts labelled '+k+' cannot tell which coil they belong to.','Give each coil its own label (KM1, KM2, K1...).',u)});
 COIL.forEach(x=>{if(x.key[0]==='#'&&!ACT.includes(x.s.id))add('info','C02','Coil without a label: '+nm(x.c),'Contacts are tied to a coil by label, so this coil cannot operate any contact.','Label it (e.g. KM1) and give its contacts the same label.',[x.c.uid])});
 EL.forEach(e=>{e.ki=e.t==='ctc'&&e.key&&KI.has(e.key)?KI.get(e.key):-1});
 const cd=new Set();EL.forEach(e=>{if(e.t==='ctc'&&!cd.has(e.c.uid)&&e.ki<0){cd.add(e.c.uid);add('warn','C03',e.key?'Contact '+e.key+' has no matching coil':'Contact without a label: '+nm(e.c),e.key?'No coil is labelled '+e.key+', so this contact is treated as never operated.':'A contact follows the coil whose label it carries; with no label it is never operated.',e.key?'Add the coil, or correct the label.':'Label it with its coil name (e.g. KM1).',[e.c.uid])}});
 COIL.forEach(x=>{if(x.key[0]!=='#'&&!ACT.includes(x.s.id)&&!EL.some(e=>e.t==='ctc'&&e.key===x.key))add('info','C04','Coil '+x.key+' operates no contacts','No contact carries the label '+x.key+', so the coil has no effect on the circuit.','Add its contacts, or ignore if it drives only an external device.',[x.c.uid])});

 /* ---------- 5. dry-run of the control logic ---------- */
 const meta={states:0,partial:false,inputs:INP.length,coils:keys.length,ms:0};
 if(SRC.length&&COIL.length){
  const Z=EL.filter(e=>e.t==='zi'||e.t==='inp'||e.t==='ctc'),Ie=EL.filter(e=>e.t==='imp'||e.t==='dir'||e.t==='coil');
  const rails=[];SRC.forEach((s,j)=>{rails.push([s.na,2*j]);rails.push([s.nb,2*j+1])});
  COIL.forEach(x=>x.ie=Ie.indexOf(EL[x.idx]));
  const closed=(e,I,K)=>e.t==='zi'?true:e.t==='inp'?(e.mode==='no'?!!I[e.i]:!I[e.i]):(e.ki<0?e.mode==='nc':(e.mode==='no'?!!K[e.ki]:!K[e.ki]));
  const solve=(I,K)=>{const p=new Int32Array(NN);for(let i=0;i<NN;i++)p[i]=i;const g=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x]}return x};for(const e of Z)if(closed(e,I,K))p[g(e.na)]=g(e.nb);return g};
  const coilsOn=g=>{
   const adj=new Map(),ad=(a,b,i)=>{if(!adj.has(a))adj.set(a,[]);adj.get(a).push([b,i])};
   Ie.forEach((e,i)=>{const a=g(e.na),b=g(e.nb);ad(a,b,i);if(e.t!=='dir')ad(b,a,i)});
   const rr=new Map();rails.forEach(([n,r])=>{const x=g(n);if(!rr.has(x))rr.set(x,[]);rr.get(x).push(r)});
   const rc=(s,skip)=>{const sn=new Set([s]),q=[s],R=new Set();while(q.length){const x=q.pop();(rr.get(x)||[]).forEach(r=>R.add(r));(adj.get(x)||[]).forEach(([y,i])=>{if(i!==skip&&!sn.has(y)){sn.add(y);q.push(y)}})}return R};
   return COIL.map(cl=>{const e=Ie[cl.ie],A=rc(g(e.na),cl.ie),B=rc(g(e.nb),cl.ie);for(let j=0;j<SRC.length;j++)if((A.has(2*j)&&B.has(2*j+1))||(A.has(2*j+1)&&B.has(2*j)))return true;return false})};
  const relax=(I,K0)=>{let K=K0.slice();for(let it=0;it<40;it++){const on=coilsOn(solve(I,K));let ch=-1;for(let x=0;x<keys.length;x++){const v=COIL.some((c,i)=>on[i]&&KI.get(c.key)===x)?1:0;if(v!==K[x]){ch=x;break}}if(ch<0)return{K,ok:true};K[ch]^=1}return{K,ok:false}};
  const st=[],sn=new Map(),edges=[];let osc=null;
  const push=(I,K,p,v)=>{const k=I.join('')+'|'+K.join('');if(sn.has(k))return sn.get(k);if(st.length>=MAXS){meta.partial=true;return -1}sn.set(k,st.length);st.push({I,K,p,v});return st.length-1};
  const I0=INP.map(()=>0),r0=relax(I0,keys.map(()=>0));push(I0,r0.K,-1,-1);
  for(let q=0;q<st.length;q++)for(let j=0;j<INP.length;j++){const I2=st[q].I.slice();I2[j]^=1;const r=relax(I2,st[q].K);if(!r.ok&&!osc)osc=[q,j];const t=push(I2,r.K,q,j);if(t>=0)edges.push([q,t])}
  meta.states=st.length;
  const trace=i=>{const p=[];while(st[i].p>=0){p.push((st[i].I[st[i].v]?'Operate ':'Release ')+INP[st[i].v].name);i=st[i].p}return p.length?p.reverse():['(the initial state, nothing operated)']};
  const on=i=>keys.filter((k,x)=>st[i].K[x]).join(', ')||'none';
  /* interlock candidates: two contactors whose main contacts meet on a non-supply net with different pole numbers */
  const sup=(()=>{const p=[];for(let i=0;i<NN;i++)p[i]=i;const g=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x]}return x};EL.forEach(e=>{if(e.t==='zi')p[g(e.na)]=g(e.nb)});const S=new Set();SRC.forEach(s=>{S.add(g(s.na));S.add(g(s.nb))});EARTH.forEach(n=>S.add(g(n)));return{g,S}})();
  const touch=new Map();EL.forEach(e=>{if(e.pw&&e.key&&e.ki>=0)[e.na,e.nb].forEach(n=>{const r=sup.g(n);if(sup.S.has(r))return;const m=touch.get(e.key)||new Map();(m.get(r)||m.set(r,new Set()).get(r)).add(e.pole);touch.set(e.key,m)})});
  const pairs=[],tk=[...touch.keys()];
  for(let a=0;a<tk.length;a++)for(let b=a+1;b<tk.length;b++){let hit=false;touch.get(tk[a]).forEach((pa,r)=>{const pb=touch.get(tk[b]).get(r);if(pb&&[...pa].some(x=>[...pb].some(y=>x!==y)))hit=true});if(hit)pairs.push([tk[a],tk[b]])}
  const es=INP.map((x,i)=>x.estop?i:-1).filter(i=>i>=0),PK=keys.map((k,i)=>EL.some(e=>e.pw&&e.key===k)||COIL.some(c=>c.key===k&&['contactor_coil','mc_coil'].includes(c.s.id))?i:-1).filter(i=>i>=0);
  let short=-1,estop=-1,ek='';const pp=pairs.map(()=>-1),ever=keys.map(()=>false);
  st.forEach((s,i)=>{
   s.K.forEach((v,x)=>{if(v)ever[x]=true});
   const g=solve(s.I,s.K);if(short<0&&SRC.some((x,j)=>!ss.has(j)&&g(x.na)===g(x.nb)))short=i;
   if(estop<0&&es.some(j=>s.I[j])){const h=PK.find(k=>s.K[k]);if(h!==undefined){estop=i;ek=keys[h]}}
   pairs.forEach((p,x)=>{if(pp[x]<0&&s.K[KI.get(p[0])]&&s.K[KI.get(p[1])])pp[x]=i});
  });
  const tr=i=>({trace:trace(i)}),srcNm=SRC.map(s=>nm(s.c)).join(' / ');
  if(short>=0)add('error','D01','Short circuit reachable','After this sequence, closed contacts join both terminals of the supply ('+srcNm+') with no load between. Energized: '+on(short)+'.','Find the path (a contact or switch bridging the supply) and put the load or the missing contact of the sequence back in it.',[],tr(short));
  if(osc)add('error','D02','Control circuit chatters (never settles)','Coils keep switching each other on and off (a contact of a coil opens its own circuit). Such a circuit hums, burns contacts and coils.','Break the loop: a coil must not have its own N/C contact in series with it without a hold-in path.',[],tr(osc[0]));
  if(estop>=0)add('error','D03','E-stop does not stop '+ek,'With an E-stop operated, the coil '+ek+' is still energized. Energized: '+on(estop)+'.','Put the E-stop (N/C) in series with the whole control supply to the coils, not only one branch.',[],tr(estop));
  pairs.forEach((p,x)=>{const u=cs.filter(c=>EL.some(e=>e.c===c&&e.pw&&(e.key===p[0]||e.key===p[1]))).map(c=>c.uid);
   if(pp[x]>=0)add('error','D04','Missing interlock: '+p[0]+' and '+p[1],'Both contactors can be closed together, yet their main contacts meet on a common line with different pole numbers (reversing, star-delta or change-over use). Both closed gives a phase-to-phase short. Energized: '+on(pp[x])+'.','Add the N/C aux contact of '+p[1]+' in series with the '+p[0]+' coil, and the N/C aux of '+p[0]+' in series with the '+p[1]+' coil (electrical interlock). A mechanical interlock is also advised.',u,tr(pp[x]));
   else if(!meta.partial)add('info','D05','Interlock verified: '+p[0]+' and '+p[1],'In every reachable state these two contactors are never closed together.','No action.',u)});
  keys.forEach((k,x)=>{const cu=COIL.filter(c=>c.key===k).map(c=>c.c.uid);if(k[0]==='#'&&!ever[x])return;
   if(!ever[x]&&!meta.partial)add('warn','D06','Coil '+k+' can never be energized','No combination of buttons and switches energizes this coil. A contact in its circuit may be in the wrong state, or a path is broken.','Trace the path from one supply terminal through the coil to the other; look for an N/O that nothing closes or an open terminal.',cu);
   if(st[0].K[x])add('warn','D07','Coil '+k+' energizes without any command','With every button released the coil is already on the moment power is applied, so the motor starts by itself.','Put a start button (N/O) in the coil path and a hold-in contact in parallel with it.',cu)});
  if(!meta.partial){const rev=st.map(()=>[]);edges.forEach(([a,b])=>rev[b].push(a));
   keys.forEach((k,x)=>{if(!ever[x])return;const ok=new Uint8Array(st.length),q=[];st.forEach((s,i)=>{if(!s.K[x]){ok[i]=1;q.push(i)}});while(q.length){const i=q.pop();rev[i].forEach(j=>{if(!ok[j]){ok[j]=1;q.push(j)}})}
    const bad=st.findIndex((s,i)=>s.K[x]&&!ok[i]);if(bad>=0)add('warn','D08','Coil '+k+' cannot be switched off once on','Once started, no button or switch can drop this coil, so the load can only be stopped by removing the supply.','Add a stop (N/C) button in series with the coil and its hold-in contact.',COIL.filter(c=>c.key===k).map(c=>c.c.uid),tr(bad))})}
 }else if(COIL.length)add('info','D00','Control logic not checked','A supply is needed to see which coils energize.','Add the control supply.',[]);
 meta.ms=Math.round(performance.now()-t0);
 const ord={error:0,warn:1,info:2};out.sort((a,b)=>ord[a.sev]-ord[b.sev]);
 return{issues:out,meta};
}

/* ---------- report panel ---------- */
function show(api,res){
 let p=document.getElementById('cbpv');
 if(!p){p=document.createElement('div');p.id='cbpv';p.style.cssText='position:fixed;top:54px;right:10px;bottom:46px;width:430px;max-width:94vw;z-index:60;background:var(--panel);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;box-shadow:0 10px 34px #000a;font:12.5px "Segoe UI",Roboto,sans-serif;color:var(--text)';document.body.appendChild(p)}
 const I=res.issues,n=s=>I.filter(x=>x.sev===s).length,col={error:'#e94560',warn:'#f1c40f',info:'#4fc3f7'},m=res.meta;
 p.innerHTML='<div style="padding:10px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:14px">Circuit check</b><button data-a="re" style="'+bs()+'">Re-run</button><button data-a="x" style="'+bs()+'">✕</button></div>'+
 '<div style="padding:8px 12px;color:var(--dim);border-bottom:1px solid var(--line)"><span style="color:'+col.error+'">'+n('error')+' errors</span> · <span style="color:'+col.warn+'">'+n('warn')+' warnings</span> · <span style="color:'+col.info+'">'+n('info')+' notes</span><br>'+(m.states?'Dry-run: '+m.states+' control states, '+m.inputs+' inputs, '+m.coils+' coils'+(m.partial?' (partial: state limit reached)':'')+' · ':'')+m.ms+' ms. Rule-based aid; it does not replace engineering review.</div>'+
 '<div style="overflow:auto;flex:1;padding:8px 10px;display:flex;flex-direction:column;gap:8px">'+(I.length?I.map((x,i)=>'<div data-i="'+i+'" style="cursor:pointer;background:var(--panel2);border-left:4px solid '+col[x.sev]+';border-radius:6px;padding:8px 10px"><div style="font-weight:600">'+esc(x.title)+' <span style="color:var(--dim);font-weight:400">'+x.id+'</span></div><div style="margin-top:3px">'+esc(x.why)+'</div>'+(x.trace?'<div style="margin-top:4px;color:var(--dim)"><b>To reproduce:</b> '+x.trace.map(esc).join(' → ')+'</div>':'')+'<div style="margin-top:4px;color:#7fe0a0"><b>Fix:</b> '+esc(x.fix)+'</div></div>').join(''):'<div style="padding:20px;text-align:center;color:#7fe0a0">No problems found.</div>')+'</div>';
 p.onclick=e=>{const a=e.target.closest('[data-a]');if(a){if(a.dataset.a==='x')p.remove();else run2(api);return}const d=e.target.closest('[data-i]');if(d){const x=I[+d.dataset.i];api.focus(x.uids,x.pos)}};
}
const bs=()=>'background:#1b2445;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer';
function run2(api){try{show(api,run(api))}catch(e){console.error(e);alert('Validator error: '+e.message)}}
window.CBPValidator={run:run2,check:run};
})();
