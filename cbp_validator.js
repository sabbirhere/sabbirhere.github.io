/* cbp_validator.js v2.0 - Circuit Builder Pro validation engine.
   No drawing code. Loaded on demand by the Validate button in CBP_Sabbir.html.

   Pipeline
     1. Build electrical nets from wires, terminals and junctions.
     2. Turn every symbol into an element (conductor, switch, coil, load...).
     3. Static checks: wiring, supply, protection, motors, electronics, labels.
     4. Dry-run: try every button/switch combination, with memory (seal-in),
        and check interlocks, E-stop, overload trip, stop buttons, latching.

   Severity rules (why something is an ERROR, not a warning)
     ERROR  the circuit cannot work, or is unsafe, as drawn: open/broken joint,
            phase loss, short circuit, unprotected feeder, motor with no overload,
            AC/DC mismatch, E-stop or overload that does not stop, missing interlock.
     WARN   probably a mistake or a risk, but the drawing can still be intentional
            (spare pole, duplicate tag, hold-to-run, no emergency stop in circuit...).
     INFO   verified facts and housekeeping. */
(function(){
'use strict';

const VERSION='2.0';
const key=l=>((l||'').trim().toUpperCase().split(/[\s(\/:,]+/)[0])||'';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const PROT=['mcb','mccb','acb','vcb','sf6','elcb','rccb','rcbo'];          // breaker kinds that give short-circuit protection
const ACT=['solenoid','shunt_trip','uv_trip','brake_coil'];                  // coils that drive actuators, not contacts
const CONTACTOR_COILS=['contactor_coil','mc_coil'];
const OL_LABEL=/^(OL|OLR|FR|TH|TOL|F|95|96)\d*$/;                            // typical overload-relay tags
const MAXS=30000;                                                           // dry-run state limit
const BUDGET_MS=2500;                                                       // dry-run time limit, keeps the page responsive
const CAT={S:'Wiring',X:'Supply',P:'Protection',M:'Motor / load',E:'Electronics',C:'Labels',D:'Control logic'};

/* true when a and b differ by exactly one character (typo detector) */
const typo=(a,b)=>{
 if(a===b||Math.abs(a.length-b.length)>1)return false;
 let i=0;while(i<a.length&&i<b.length&&a[i]===b[i])i++;
 if(a.length===b.length)return a.slice(i+1)===b.slice(i+1);
 return a.length>b.length?a.slice(i+1)===b.slice(i):b.slice(i+1)===a.slice(i);
};

function run(api){
 const t0=performance.now(),out=[],SYM=api.SYM,cs=api.components.filter(c=>SYM[c.symbolId]);
 const nm=c=>(c.label&&c.label.trim())||SYM[c.symbolId].name+' #'+c.uid;
 const add=(sev,id,title,why,fix,uids,x)=>out.push(Object.assign({sev,id,title,why,fix,uids:uids||[],cat:CAT[id[0]]||'General'},x||{}));
 const list=a=>a.length>4?a.slice(0,4).join(', ')+' +'+(a.length-4)+' more':a.join(', ');

 /* union-find over terminal keys and wire ids */
 const par=new Map(),f=x=>{if(!par.has(x))par.set(x,x);let r=x;while(par.get(r)!==r)r=par.get(r);while(par.get(x)!==r){const n=par.get(x);par.set(x,r);x=n}return r},un=(a,b)=>par.set(f(a),f(b));
 const pk=(u,p)=>u+':'+p,near=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<2;
 const segHit=(p,pts)=>{for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i],dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy||1,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l));if(Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<2)return true}return false};

 /* ================= 1. NETS ================= */
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
  if(!hit)dangling.push({o,x:p.x,y:p.y,seg:WS.some(o2=>o2!==o&&segHit(p,o2.pts))});
 }));
 const ids=new Map(),N=k=>{const r=f(k);if(!ids.has(r))ids.set(r,ids.size);return ids.get(r)};
 const portNets=new Set();cs.forEach(c=>PW.get(c.uid).forEach(q=>portNets.add(f(pk(c.uid,q.id)))));

 /* ================= 2. ELEMENTS ================= */
 const EL=[],INP=[],COIL=[],SRC=[],EARTH=[],MOT=[],TAP=[],EXT=[],inpOf=new Map();
 const hasPoles=c=>PW.get(c.uid).length>1;
 cs.forEach(c=>{
  const s=SYM[c.symbolId],k=s.kind,pid=PW.get(c.uid).map(q=>q.id),L=key(c.label);
  const pl=()=>pid.includes('a1')?pid.filter(i=>/^a\d+$/.test(i)).map(a=>[a,'b'+a.slice(1),+a.slice(1)]):[['a','b',0]];
  const E=(a,b,t,o)=>EL.push(Object.assign({c,s,na:N(pk(c.uid,a)),nb:N(pk(c.uid,b)),t,pole:0},o||{}));
  const isEstop=(k==='pb'&&s.variant==='estop')||(k==='ctl'&&s.head==='emerg');
  const momentary=(k==='pb'&&/^(no|nc)$/.test(s.variant))||(k==='ctl'&&(s.head==='push'||s.head==='pull'));
  const inp=(a,b,mode)=>{let i=inpOf.get(c.uid);if(i===undefined){i=INP.length;inpOf.set(c.uid,i);
   const ol=s.bkind==='ol'||(mode==='nc'&&OL_LABEL.test(L));
   INP.push({c,name:nm(c),estop:isEstop,ol,mom:momentary,stop:!isEstop&&!ol&&momentary&&mode==='nc'})}
   E(a,b,'inp',{i,mode})};
  const ab=pid.includes('a')&&pid.includes('b'),bk=s.bkind;
  const olIec=s.mark==='ctr'?!!s.trip:s.id==='iec_mpcb_3p';
  if(k==='source'||k==='battery'){if(ab)SRC.push({c,na:N(pk(c.uid,'a')),nb:N(pk(c.uid,'b')),dc:k==='battery'||/^(dc_supply|generator_dc)$/.test(s.id),ph1:s.id==='ac_1ph',ph3:s.id==='ac_3ph'||s.id==='generator_ac'})}
  else if(k==='earth')EARTH.push({net:N(pk(c.uid,'a')),variant:s.variant,c});
  else if(k==='motorX'||k==='load3ph'){const line=pid.filter(i=>!/^b/.test(i)).map(i=>N(pk(c.uid,i)));
   MOT.push({c,s,nets:pid.map(i=>N(pk(c.uid,i))),line,dc:!!s.dc,three:(s.top||0)>=3||k==='load3ph'})}
  else if(k==='lamp'||k==='alarm')TAP.push({c,net:N(pk(c.uid,'a'))});
  else if(k==='fuseN'||k==='ovl')pl().forEach(p=>E(p[0],p[1],'zi',{prot:1,ol:k==='ovl',pole:p[2]}));
  else if(k==='resV')pl().forEach(p=>E(p[0],p[1],'imp',{pole:p[2]}));
  else if((k==='ovlEl'||k==='xfmr'||(k==='passive'&&/resistor|inductor|reactor/.test(s.variant))||(k==='powerElec'&&!/igbt|mosfet/.test(s.id)))&&ab)
   E('a','b','imp',{ol:k==='ovlEl',xf:k==='xfmr',conv:k==='powerElec'&&/vfd|soft_starter/.test(s.id)});
  else if(k==='semiconductor'&&s.variant!=='thyristor')E('a','b','dir',{semi:s.variant,conv:1});
  else if(k==='coil'||k==='coilV'){E('a','b','coil',{key:L||'#'+c.uid});COIL.push({c,s,key:L||'#'+c.uid,idx:EL.length-1})}
  else if(k==='contact'){if(s.variant==='spdt'){E('com','no','ctc',{key:L,mode:'no'});E('com','nc','ctc',{key:L,mode:'nc'})}else E('a','b','ctc',{key:L,mode:s.variant})}
  else if(k==='contact3ph')pl().forEach(p=>E(p[0],p[1],'ctc',{key:L,mode:s.variant,pole:p[2],pw:1}));
  else if(k==='iec')pl().forEach(p=>s.mark==='ctr'?E(p[0],p[1],'ctc',{key:L,mode:'no',pole:p[2],pw:1,prot:!!s.trip,ol:olIec}):E(p[0],p[1],'zi',{prot:s.mark==='cb'||!!s.trip,ol:olIec,pole:p[2]}));
  else if(k==='ctl'){if(s.form==='co'){inp('com','nc','nc');inp('com','no','no')}else if(s.form==='x'){inp('a1','b1','nc');inp('a2','b2','no')}else inp('a','b',s.form)}
  else if(k==='pb')inp('a','b',/nc|estop/.test(s.variant)?'nc':'no');
  else if(k==='fieldSwitch')inp('a','b','no');
  else if(k==='breaker'){if(bk==='switch')inp('a','b','no');else if(bk==='ol')inp('a','b','nc');else if(!['earth_sw','spd','arrester','ef'].includes(bk)&&ab)E('a','b','zi',{prot:PROT.includes(bk)})}
  /* devices the dry-run cannot model but which may drive a coil from outside */
  if(k==='ansiRelay'||(k==='semiconductor'&&s.variant==='thyristor')||(k==='powerElec'&&/igbt|mosfet/.test(s.id)))pid.forEach(i=>EXT.push(N(pk(c.uid,i))));
 });
 const NN=ids.size;
 const series=new Set([...EL.map(e=>e.c),...SRC.map(s=>s.c),...MOT.map(m=>m.c)]);

 /* reachability over the static graph (contacts and switches assumed closed, coils never conduct) */
 const reach=(starts,skip)=>{const adj=[];EL.forEach(e=>{if(e.t==='coil'||(skip&&skip(e)))return;(adj[e.na]=adj[e.na]||[]).push(e.nb);if(e.t!=='dir')(adj[e.nb]=adj[e.nb]||[]).push(e.na)});
  const R=new Set(),q=[];starts.forEach(n=>{R.add(n);q.push(n)});while(q.length){const x=q.pop();(adj[x]||[]).forEach(y=>{if(!R.has(y)){R.add(y);q.push(y)}})}return R};
 const srcNets=S=>S.flatMap(s=>[s.na,s.nb]);
 const allSrc=srcNets(SRC),acSrc=SRC.filter(s=>!s.dc),dcSrc=SRC.filter(s=>s.dc);
 const hasAC=acSrc.length>0;

 /* ================= 3. STATIC CHECKS ================= */

 /* ---- 3a. wiring ---- */
 dangling.forEach(d=>{
  const live=portNets.has(f(d.o.id));
  if(live)add('error','S01',d.seg?'Broken joint: wire ends on the side of another wire':'Open circuit: wire end not connected',
   d.seg?'This wire ends in the middle of another wire, not on a vertex of it, so the two are NOT joined electrically. Everything beyond this point is dead.':'This wire is attached to a component at its other end but this end is floating, so the path is open and nothing downstream is supplied.',
   d.seg?'End the wire on a vertex of the other wire (add a junction dot there) or on a terminal.':'Drag the free end onto the intended terminal, or delete the wire.',[],{pos:{x:d.x,y:d.y}});
  else add('warn','S13','Stray wire (touches no component)','This wire is not connected to any terminal, so it has no electrical meaning.','Delete it, or finish connecting it.',[],{pos:{x:d.x,y:d.y}});
 });
 const wk=new Map();WS.forEach(o=>{if(o.pts.length<2)return;const a=o.pts.map(p=>Math.round(p.x)+','+Math.round(p.y)),k1=a.join(';'),k2=a.slice().reverse().join(';');
  if(wk.has(k1)||wk.has(k2))add('info','S12','Duplicate wire','Two wires follow exactly the same route.','Delete one of them.',[],{pos:{x:o.pts[0].x,y:o.pts[0].y}});else wk.set(k1,1)});
 /* a wire passes over a terminal but is not connected to it: looks joined, is not */
 const falseTouch=new Map();
 cs.forEach(c=>PW.get(c.uid).forEach(q=>{const r=f(pk(c.uid,q.id));
  WS.forEach(o=>{if(f(o.id)!==r&&segHit(q,o.pts)){const e=falseTouch.get(c.uid)||{ports:new Set(),unused:false};e.ports.add(q.id);if(!used.has(pk(c.uid,q.id)))e.unused=true;falseTouch.set(c.uid,e)}})}));
 falseTouch.forEach((e,uid)=>{const c=cs.find(x=>x.uid===uid),junction=SYM[c.symbolId].kind==='basicMisc';
  add(junction||e.unused?'error':'warn','S11',junction?'Junction on a wire but not connected: '+nm(c):'Wire touches terminal without connecting: '+nm(c),
   'A wire passes exactly over terminal '+[...e.ports].join(', ')+' but is not attached to it. On screen it looks joined; electrically it is not.',
   'Re-draw the wire so it ends on the terminal (or on a vertex that is joined to it).',[uid])});
 cs.forEach(c=>{
  const s=SYM[c.symbolId],k=s.kind,pid=PW.get(c.uid).map(q=>q.id),open=pid.filter(i=>!used.has(pk(c.uid,i)));
  if(k==='basicMisc'||k==='bus'||!pid.length)return;
  if(open.length===pid.length){
   const important=['source','battery','motorX','load3ph','fuseN','ovl','iec','breaker','coil','coilV','contact3ph','xfmr'].includes(k);
   add(important?'warn':'info','S02','Isolated component: '+nm(c),'It has no wire on any terminal, so it takes no part in the circuit.','Wire it in or delete it.',[c.uid]);return}
  if(!open.length)return;
  const wired=pid.filter(i=>!open.includes(i)),aP=pid.filter(i=>/^a\d+$/.test(i)),bP=pid.filter(i=>/^b\d+$/.test(i)),tP=pid.filter(i=>/^t\d+$/.test(i));
  const u=i=>used.has(pk(c.uid,i));
  if(tP.length&&!s.dc){
   add('error','S03','Phase loss: '+nm(c)+' wired on '+wired.length+' of '+pid.length+' terminals','Terminal(s) '+open.join(', ')+' are not connected. The machine would run on fewer phases (single-phasing) and burn out, or not start.','Connect every supply terminal.',[c.uid]);return}
  if(aP.length&&bP.length){
   const full=[],half=[],none=[];aP.forEach(a=>{const b='b'+a.slice(1),ua=u(a),ub=u(b);(ua&&ub?full:ua||ub?half:none).push(a.slice(1))});
   if(half.length){add('error','S03','Pole '+half.join(', ')+' of '+nm(c)+' wired on one side only','The conductor enters (or leaves) this pole but the other side is not connected, so no current can pass through it.','Wire both terminals of the pole, or remove the stray wire.',[c.uid]);return}
   if(none.length&&full.length){
    const feeds3=MOT.some(m=>m.three&&!m.dc)&&aP.length>=3;
    add(feeds3?'error':'warn','S03',(feeds3?'Phase loss: ':'Spare pole: ')+nm(c)+' pole(s) '+none.join(', ')+' not wired',
     feeds3?'A three-phase machine is in this circuit but this device passes only '+full.length+' of its '+aP.length+' poles, so a phase is missing.':'Pole(s) '+none.join(', ')+' are unused. Fine for a spare pole; a mistake if that pole should carry a phase or neutral.',
     feeds3?'Wire every pole to its phase.':'Connect the pole, or ignore if it is intentionally spare.',[c.uid]);return}
   if(none.length&&!full.length)return}
  if((s.ports==='spdt'||s.ports==='co_v')&&wired.length>=2)return;
  if(series.has(c))add('error','S03','Open circuit at '+nm(c),'Only terminal(s) '+wired.join(', ')+' are wired; '+open.join(', ')+' '+(open.length>1?'are':'is')+' not. Current cannot pass through the device, so the branch is dead.','Connect the missing terminal, or remove the device from the path.',[c.uid]);
  else add('warn','S03','Open terminal on '+nm(c),'Terminal(s) '+open.join(', ')+' have no wire.','Connect the terminal, or ignore if it is intentionally spare.',[c.uid]);
 });
 const seen=new Map();cs.forEach(c=>{const k=c.symbolId+'@'+c.x+','+c.y;if(seen.has(k))add('warn','S04','Duplicate component on top of another: '+nm(c),'Two identical symbols sit at the same position, so a wire may attach to the wrong one.','Delete the duplicate.',[c.uid,seen.get(k)]);else seen.set(k,c.uid)});
 const ss=new Set();SRC.forEach((s,j)=>{if(s.na===s.nb){ss.add(j);add('error','S05','Source shorted: '+nm(s.c),'Both terminals of this source are on the same net, so it is short-circuited permanently.','Remove the wire joining the two terminals.',[s.c.uid])}});
 EL.forEach(e=>{if((e.t==='coil'||e.t==='imp'||e.t==='dir')&&e.na===e.nb)add(e.t==='coil'?'error':'warn','S06',(e.t==='coil'?'Coil shorted out: ':'Component bypassed: ')+nm(e.c),
  e.t==='coil'?'Both terminals of the coil are on the same net, so no voltage can ever appear across it and it can never operate.':'Both terminals are on the same net, so current skips this component entirely.','Check the wiring at this component.',[e.c.uid])});
 /* earthing */
 const motorsAC=MOT.filter(m=>!m.dc);
 const earthUsed=EARTH.filter(e=>used.has(pk(e.c.uid,'a')));
 if(SRC.length&&!earthUsed.length){
  const dangle=EARTH.length?' The earth symbol on the sheet is not wired to anything.':'';
  if(hasAC&&MOT.length)add('error','S07','No protective earth in a motor circuit','AC supply and motors are present but no earth/PE is connected. Motor frames cannot be bonded, so a winding fault leaves the frame live: shock hazard and no earth-fault trip.'+dangle,'Add PE, bond the motor frames and the supply earth point.',EARTH.map(e=>e.c.uid));
  else add(hasAC?'warn':'info','S07','No earth or PE in the circuit','Sources are present but there is no connected earth symbol, so there is no protective earth or reference.'+dangle,'Add PE/earth and bond frames, the neutral and the surge devices.',EARTH.map(e=>e.c.uid))}
 else if(hasAC&&MOT.length&&earthUsed.length&&!earthUsed.some(e=>/^(pe|ground|rod)$/.test(e.variant)))add('warn','S07','Only neutral/NGR earth symbols, no PE','Motors are present but no protective-earth (PE/ground) symbol is used, only neutral or NGR symbols.','Add a PE symbol and bond the motor frames to it.',[]);
 if(!SRC.length)add('info','S08','No source found','Without a supply symbol, no supply-dependent check can run.','Add an AC/DC supply, generator, battery or PV panel.',[]);

 /* ---- 3b. protection reach ---- */
 if(SRC.length&&MOT.length){
  const A=reach(allSrc),P=reach(allSrc,e=>e.prot),O=reach(allSrc,e=>e.ol);
  const open=(m,R)=>m.three||m.line.length>=3?m.line.some(n=>R.has(n)):m.line.every(n=>R.has(n));   // 3-phase: any bare phase; 1-phase/DC: line side with no protection
  MOT.forEach(m=>{
   if(!m.nets.some(n=>A.has(n))){add('error','S09','No supply path to '+nm(m.c),'No chain of wires, switches and devices connects this load to any source.','Check the feeder wiring and that no wire end is left open.',[m.c.uid]);return}
   if(open(m,P)){add('error','S10','Unprotected feeder to '+nm(m.c),'A route from the source reaches this load without passing a fuse, breaker or overload. A fault on the cable or in the machine has nothing to clear it.','Add short-circuit protection (fuse/MCCB) in every route and, for motors, an overload.',[m.c.uid]);return}
   if(m.s.kind==='motorX'&&open(m,O))add('error','P01','No motor overload protection: '+nm(m.c),'The motor is fed through a short-circuit device only. A stalled or overloaded motor draws current below the fuse rating and burns out.','Add a thermal overload or motor-protection breaker (MPCB) in the motor feeder.',[m.c.uid]);
  });
 }
 /* control circuit fed without any protective device */
 if(SRC.length&&COIL.length){const P=reach(allSrc,e=>e.prot);
  const bare=COIL.filter(x=>{const e=EL[x.idx];return P.has(e.na)&&P.has(e.nb)});
  if(bare.length)add('warn','P02','Control circuit has no protective device','Coils ('+list(bare.map(x=>x.key[0]==='#'?nm(x.c):x.key))+') can be reached from the supply with nothing in the way to clear a control-wiring fault.','Add a fuse or small MCB in the control supply.',bare.map(x=>x.c.uid))}
 /* overload element drawn but its trip contact never reaches the control circuit */
 if(EL.some(e=>e.c&&e.s.kind==='ovl')&&COIL.some(x=>CONTACTOR_COILS.includes(x.s.id))&&!INP.some(i=>i.ol)&&!EL.some(e=>(e.t==='ctc'||e.t==='inp')&&e.mode==='nc'&&OL_LABEL.test(e.key||key(e.c.label))))
  add('error','P03','Overload trip contact is not in the control circuit','A thermal overload is in the power circuit but no N/C trip contact (95-96) is wired into the coil circuit. When the overload trips, the contactor stays closed and the motor is not disconnected.','Wire the overload N/C contact in series with the contactor coil, and label it (OL1 / F2).',EL.filter(e=>e.s.kind==='ovl').map(e=>e.c.uid).filter((v,i,a)=>a.indexOf(v)===i));

 /* ---- 3c. supply: AC/DC, phases, parallel sources ---- */
 if(SRC.length){
  const conv=e=>e.conv,rAC=reach(srcNets(acSrc),conv),rDC=reach(srcNets(dcSrc),e=>e.conv||e.xf);
  const inR=(R,nets)=>nets.some(n=>R.has(n));
  MOT.forEach(m=>{
   if(m.dc&&inR(rAC,m.nets)&&!inR(rDC,m.nets))add('error','X01','DC motor on an AC supply: '+nm(m.c),'The only source reaching this DC machine is AC, with no rectifier or converter between them.','Insert a rectifier/drive, or use an AC motor.',[m.c.uid]);
   if(!m.dc&&inR(rDC,m.nets)&&!inR(rAC,m.nets))add('error','X01','AC machine on a DC supply: '+nm(m.c),'The only source reaching this AC machine is DC, with no inverter or drive between them.','Insert an inverter/VFD, or use a DC machine.',[m.c.uid])});
  EL.forEach(e=>{if(e.xf&&inR(rDC,[e.na,e.nb])&&!inR(rAC,[e.na,e.nb]))add('error','X01','Transformer on DC supply: '+nm(e.c),'A transformer does not pass DC; the winding would just see a short circuit.','Feed it from an AC source or inverter.',[e.c.uid])});
  const mix=dcSrc.filter(s=>rAC.has(s.na)||rAC.has(s.nb));
  if(mix.length&&acSrc.length)add('error','X02','AC and DC sources are joined','A DC source ('+list(mix.map(s=>nm(s.c)))+') is wired to the same network as an AC source with no rectifier or converter between them.','Separate the two networks or add the converter.',[...mix.map(s=>s.c.uid)]);
  const g1=SRC.filter(s=>s.ph1),g3=SRC.filter(s=>s.ph3),r1=reach(srcNets(g1),conv),r3=reach(srcNets(g3),conv);
  MOT.forEach(m=>{if(m.three&&!m.dc&&inR(r1,m.nets)&&!inR(r3,m.nets))add('error','X04','Three-phase machine on a single-phase supply: '+nm(m.c),'The only AC source reaching it is single-phase, so it cannot start or will run on one phase.','Use a three-phase supply, or a single-phase machine.',[m.c.uid])});
  for(let a=0;a<SRC.length;a++)for(let b=a+1;b<SRC.length;b++){const A=SRC[a],B=SRC[b];if(A.na===A.nb||B.na===B.nb)continue;
   const same=A.na===B.na&&A.nb===B.nb,rev=A.na===B.nb&&A.nb===B.na;if(!same&&!rev)continue;
   if(A.dc&&B.dc&&rev)add('error','X03','DC sources in opposition: '+nm(A.c)+' / '+nm(B.c),'The two sources are connected in parallel with opposite polarity, so each one drives a short circuit through the other.','Reverse one source.',[A.c.uid,B.c.uid]);
   else if(A.dc&&B.dc)add('warn','X03','DC sources in parallel: '+nm(A.c)+' / '+nm(B.c),'Paralleled sources with unequal voltage circulate current between them.','Match voltages and add blocking diodes or fuses per source.',[A.c.uid,B.c.uid]);
   else if(!A.dc&&!B.dc)add('warn','X03','AC sources in parallel: '+nm(A.c)+' / '+nm(B.c),'Two AC sources joined with no synchronising check will drive large circulating current if voltage, phase or frequency differ.','Add a sync-check (25) and breaker for each source.',[A.c.uid,B.c.uid])}
 }
 /* conductor sharing: poles of one device on the same line while other devices keep phases apart */
 const pole=c=>{const p=PW.get(c.uid).map(q=>q.id),a=p.filter(i=>/^a\d+$/.test(i)),b=p.filter(i=>/^b\d+$/.test(i));return{a,b}};
 const poleNets=(c,ports)=>ports.every(i=>used.has(pk(c.uid,i)))?ports.map(i=>N(pk(c.uid,i))):null;
 const multi=cs.some(c=>{const {a}=pole(c);const n=poleNets(c,a);return n&&n.length>1&&new Set(n).size>1});
 if(multi)cs.forEach(c=>{
  const s=SYM[c.symbolId],{a,b}=pole(c),sides=[['a',a]];if(s.kind!=='motorX'&&s.kind!=='load3ph')sides.push(['b',b]);
  const tP=PW.get(c.uid).map(q=>q.id).filter(i=>/^t\d+$/.test(i));if(tP.length>1)sides.push(['t',tP]);
  sides.forEach(([sd,ports])=>{const n=poleNets(c,ports);if(!n||n.length<2)return;const d=new Set(n).size;
   if(d>1&&d<n.length)add('error','X05','Two phases joined at '+nm(c),'On the '+(sd==='b'?'load':'supply')+' side, '+(n.length-d+1)+' terminals of this device sit on the same conductor while other poles carry separate phases. That is a phase-to-phase short through the wiring, or a lost phase.','Give each pole its own phase conductor.',[c.uid])})});
 /* indicators that can never be powered */
 if(SRC.length){const A=reach(allSrc);TAP.forEach(t=>{if(!A.has(t.net))add('warn','M02','Indicator not supplied: '+nm(t.c),'The lamp/alarm terminal is not connected to any path from a source.','Wire it to the supply through its switching contact.',[t.c.uid])})}

 /* ---- 3d. electronics ---- */
 if(SRC.length){
  const mk=(skip)=>{const p=[];for(let i=0;i<NN;i++)p[i]=i;const g=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x]}return x};EL.forEach(e=>{if(skip(e))p[g(e.na)]=g(e.nb)});return g};
  const gDef=mk(e=>e.t==='zi'),gCond=mk(e=>e.t==='zi'||e.t==='inp'||e.t==='ctc'),done=new Set();
  const across=(g,e)=>SRC.some(s=>(g(e.na)===g(s.na)&&g(e.nb)===g(s.nb))||(g(e.na)===g(s.nb)&&g(e.nb)===g(s.na)));
  EL.forEach(e=>{if(e.t!=='dir'||e.semi==='')return;const led=e.semi==='led';
   if(across(gDef,e)){done.add(e);add('error','E01',(led?'LED':'Diode')+' connected directly across the supply: '+nm(e.c),led?'An LED needs a series resistor; with none it draws excessive current and fails at once.':'With no series impedance the diode forward-conducts into the source: a short circuit.','Add a series resistor (LED) or the intended load (diode).',[e.c.uid])}
   else if(across(gCond,e))add('error','E02',(led?'LED':'Diode')+' has no current limit when a switch closes: '+nm(e.c),'The only thing between the supply and this '+(led?'LED':'diode')+' is a switch or contact. The moment it closes the '+(led?'LED burns out':'diode shorts the source')+'.','Add a series resistor or load in the branch.',[e.c.uid])});
 }

 /* ================= 4. LABELS AND CONTACTS ================= */
 const keys=[...new Set(COIL.map(x=>x.key))],KI=new Map(keys.map((k,i)=>[k,i]));
 const cnt=new Map();COIL.forEach(x=>cnt.set(x.key,(cnt.get(x.key)||[]).concat(x.c.uid)));
 cnt.forEach((u,k)=>{if(u.length>1&&k[0]!=='#')add('warn','C01','Two coils share the label '+k,'Contacts labelled '+k+' cannot tell which coil they belong to.','Give each coil its own label (KM1, KM2, K1...).',u)});
 COIL.forEach(x=>{if(x.key[0]==='#'&&!ACT.includes(x.s.id))add('info','C02','Coil without a label: '+nm(x.c),'Contacts are tied to a coil by label, so this coil cannot operate any contact.','Label it (e.g. KM1) and give its contacts the same label.',[x.c.uid])});
 EL.forEach(e=>{e.ki=e.t==='ctc'&&e.key&&KI.has(e.key)?KI.get(e.key):-1});
 const cd=new Set();EL.forEach(e=>{if(e.t==='ctc'&&!cd.has(e.c.uid)&&e.ki<0){cd.add(e.c.uid);
  const guess=e.key?keys.filter(k=>k[0]!=='#'&&typo(e.key,k)):[];
  if(guess.length)add('error','C03','Contact '+e.key+' matches no coil (did you mean '+guess.join(' / ')+'?)','No coil is labelled '+e.key+', but '+list(guess)+' exist'+(guess.length>1?'':'s')+'. A one-character typo leaves this contact permanently un-operated, which breaks seal-in and interlock logic.','Correct the label.',[e.c.uid]);
  else add('warn','C03',e.key?'Contact '+e.key+' has no matching coil':'Contact without a label: '+nm(e.c),e.key?'No coil is labelled '+e.key+', so this contact is treated as never operated.':'A contact follows the coil whose label it carries; with no label it is never operated.',e.key?'Add the coil, or correct the label.':'Label it with its coil name (e.g. KM1).',[e.c.uid])}});
 COIL.forEach(x=>{
  if(x.key[0]==='#'||ACT.includes(x.s.id))return;
  const mine=EL.filter(e=>e.t==='ctc'&&e.key===x.key);
  if(!mine.length)add('info','C04','Coil '+x.key+' operates no contacts','No contact carries the label '+x.key+', so the coil has no effect on the circuit.','Add its contacts, or ignore if it drives only an external device.',[x.c.uid]);
  else if(MOT.length&&CONTACTOR_COILS.includes(x.s.id)&&!mine.some(e=>e.pw))add('warn','P05','Contactor coil '+x.key+' has no power contacts','Only auxiliary contacts carry the label '+x.key+'. No main (3-pole/power) contact is driven, so the coil switches no motor.','Add the main contacts and label them '+x.key+'.',[x.c.uid])});
 const tags=new Map();cs.forEach(c=>{const s=SYM[c.symbolId];if(!(c.label&&c.label.trim()))return;
  /* device tags only; contacts, buttons and overload contacts legitimately repeat the tag of their parent device */
  if(!['fuseN','motorX','load3ph','xfmr','source','battery','ovl'].includes(s.kind)&&!(s.kind==='breaker'&&s.bkind!=='ol'&&s.bkind!=='switch'))return;
  const t=c.label.trim().toUpperCase();(tags.get(t)||tags.set(t,[]).get(t)).push(c.uid)});
 tags.forEach((u,t)=>{if(u.length>1)add('warn','C06','Tag '+t+' used on '+u.length+' devices','Two or more devices share one tag, so they cannot be told apart on drawings, in lists or by contacts.','Give every device a unique tag.',u)});

 /* ================= 5. DRY-RUN OF THE CONTROL LOGIC ================= */
 const meta={states:0,partial:false,inputs:INP.length,coils:keys.length,ms:0,comps:cs.length,wires:WS.length,nets:NN,version:VERSION};
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
  const infl=INP.map(()=>keys.map(()=>false));                                // does input j ever change coil x?
  const push=(I,K,p,v)=>{const k=I.join('')+'|'+K.join('');if(sn.has(k))return sn.get(k);if(st.length>=MAXS){meta.partial=true;return -1}sn.set(k,st.length);st.push({I,K,p,v});return st.length-1};
  const I0=INP.map(()=>0),r0=relax(I0,keys.map(()=>0));push(I0,r0.K,-1,-1);
  for(let q=0;q<st.length;q++){if(performance.now()-t0>BUDGET_MS){meta.partial=true;break}for(let j=0;j<INP.length;j++){
   const I2=st[q].I.slice();I2[j]^=1;const r=relax(I2,st[q].K);if(!r.ok&&!osc)osc=[q,j];
   if(r.ok)for(let x=0;x<keys.length;x++)if(r.K[x]!==st[q].K[x])infl[j][x]=true;
   const t=push(I2,r.K,q,j);if(t>=0)edges.push([q,t])}}
  meta.states=st.length;
  const trace=i=>{const p=[];while(st[i].p>=0){p.push((st[i].I[st[i].v]?'Operate ':'Release ')+INP[st[i].v].name);i=st[i].p}return p.length?p.reverse():['(the initial state, nothing operated)']};
  const on=i=>keys.filter((k,x)=>st[i].K[x]).join(', ')||'none';
  const tr=i=>({trace:trace(i)}),srcNm=SRC.map(s=>nm(s.c)).join(' / ');
  const coilUids=k=>COIL.filter(c=>c.key===k).map(c=>c.c.uid);
  /* contactors that switch a motor: have power contacts or a contactor-type coil */
  const PK=keys.map((k,i)=>EL.some(e=>e.pw&&e.key===k)||COIL.some(c=>c.key===k&&CONTACTOR_COILS.includes(c.s.id))?i:-1).filter(i=>i>=0);
  /* interlock candidates: two contactors whose main contacts meet on a non-supply net with different pole numbers */
  const sup=(()=>{const p=[];for(let i=0;i<NN;i++)p[i]=i;const g=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x]}return x};EL.forEach(e=>{if(e.t==='zi')p[g(e.na)]=g(e.nb)});const S=new Set();SRC.forEach(s=>{S.add(g(s.na));S.add(g(s.nb))});EARTH.forEach(e=>S.add(g(e.net)));return{g,S}})();
  const touch=new Map();EL.forEach(e=>{if(e.pw&&e.key&&e.ki>=0)[e.na,e.nb].forEach(n=>{const r=sup.g(n);if(sup.S.has(r))return;const m=touch.get(e.key)||new Map();(m.get(r)||m.set(r,new Set()).get(r)).add(e.pole);touch.set(e.key,m)})});
  const pairs=[],tk=[...touch.keys()];
  for(let a=0;a<tk.length;a++)for(let b=a+1;b<tk.length;b++){let hit=false;touch.get(tk[a]).forEach((pa,r)=>{const pb=touch.get(tk[b]).get(r);if(pb&&[...pa].some(x=>[...pb].some(y=>x!==y)))hit=true});if(hit)pairs.push([tk[a],tk[b]])}
  let short=-1;const pp=pairs.map(()=>-1),ever=keys.map(()=>false),hit=new Map();
  const PROTIN=INP.map(x=>x.estop||x.ol||x.stop);
  st.forEach((s,i)=>{
   s.K.forEach((v,x)=>{if(v)ever[x]=true});
   const g=solve(s.I,s.K);if(short<0&&SRC.some((x,j)=>!ss.has(j)&&g(x.na)===g(x.nb)))short=i;
   pairs.forEach((p,x)=>{if(pp[x]<0&&s.K[KI.get(p[0])]&&s.K[KI.get(p[1])])pp[x]=i});
   INP.forEach((x,j)=>{if(!s.I[j]||!PROTIN[j])return;keys.forEach((k,xi)=>{if(s.K[xi]&&!hit.has(j+'|'+xi))hit.set(j+'|'+xi,i)})});
  });

  if(short>=0)add('error','D01','Short circuit reachable','After this sequence, closed contacts join both terminals of the supply ('+srcNm+') with no load between. Energized: '+on(short)+'.','Find the path (a contact or switch bridging the supply) and put the load or the missing contact of the sequence back in it.',[],tr(short));
  if(osc)add('error','D02','Control circuit chatters (never settles)','Coils keep switching each other on and off (a contact of a coil opens its own circuit). Such a circuit hums, burns contacts and coils.','Break the loop: a coil must not have its own N/C contact in series with it without a hold-in path.',[],tr(osc[0]));

  /* protective inputs: E-stop, overload trip, stop button must drop the contactors */
  const worst=(j,xs)=>{let b=-1;xs.forEach(x=>{const i=hit.get(j+'|'+x);if(i!==undefined&&(b<0||i<b))b=i});return b};
  INP.forEach((inp,j)=>{
   if(!PROTIN[j])return;
   const xs=PK.filter(x=>inp.estop||infl[j][x]),bad=xs.filter(x=>hit.has(j+'|'+x)),nameOf=x=>keys[x];
   if(bad.length){const i=worst(j,bad),u=[inp.c.uid,...bad.flatMap(x=>coilUids(keys[x]))];
    if(inp.estop)add('error','D03','E-stop does not stop '+list(bad.map(nameOf)),'With '+inp.name+' operated, '+list(bad.map(nameOf))+' stays energized. Energized: '+on(i)+'.','Put the E-stop (N/C) in series with the whole control supply to the coils, not only one branch.',u,tr(i));
    else if(inp.ol)add('error','D09','Overload trip does not stop '+list(bad.map(nameOf)),'With '+inp.name+' tripped, '+list(bad.map(nameOf))+' stays energized, so the motor keeps running into the overload. Energized: '+on(i)+'.','Put the overload N/C contact in series with the coil (after the stop button, before the coil), outside the hold-in branch.',u,tr(i));
    else add('error','D11','Stop button '+inp.name+' does not stop '+list(bad.map(nameOf)),'With the stop button held operated, '+list(bad.map(nameOf))+' is still energized (usually through a hold-in contact that bypasses the stop). Energized: '+on(i)+'.','Put the stop button (N/C) in series with the whole coil path, ahead of the start button and the hold-in contact.',u,tr(i))}
   else if(!meta.partial&&(inp.ol||inp.estop||inp.stop)&&!infl[j].some(Boolean)&&PK.length)
    add('error','D12',(inp.estop?'E-stop ':inp.ol?'Overload contact ':'Stop button ')+inp.name+' has no effect on any coil','Operating it never changes the state of any coil, so it is not wired into the control circuit that matters.','Connect it in series with the coil path.',[inp.c.uid])});
  if(PK.length&&!INP.some(x=>x.estop))add('info','D14','No emergency stop in the control circuit','Contactors switch motors but no E-stop device is wired. Required on most machines (IEC 60204-1, category 0/1 stop).','Add an E-stop (N/C) that drops the contactor coils.',[]);

  pairs.forEach((p,x)=>{const u=cs.filter(c=>EL.some(e=>e.c===c&&e.pw&&(e.key===p[0]||e.key===p[1]))).map(c=>c.uid);
   if(pp[x]>=0)add('error','D04','Missing interlock: '+p[0]+' and '+p[1],'Both contactors can be closed together, yet their main contacts meet on a common line with different pole numbers (reversing, star-delta or change-over use). Both closed gives a phase-to-phase short. Energized: '+on(pp[x])+'.','Add the N/C aux contact of '+p[1]+' in series with the '+p[0]+' coil, and the N/C aux of '+p[0]+' in series with the '+p[1]+' coil (electrical interlock). A mechanical interlock is also advised.',u,tr(pp[x]));
   else if(!meta.partial)add('info','D05','Interlock verified: '+p[0]+' and '+p[1],'In every reachable state these two contactors are never closed together.','No action.',u)});

  const extNet=(()=>{const p=[];for(let i=0;i<NN;i++)p[i]=i;const g=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x]}return x};EL.forEach(e=>p[g(e.na)]=g(e.nb));const X=new Set(EXT.map(g));return c=>{const e=EL[c.idx];return X.has(g(e.na))}})();
  keys.forEach((k,x)=>{const cu=coilUids(k);if(k[0]==='#'&&!ever[x])return;const motor=PK.includes(x);
   if(!ever[x]&&!meta.partial){const ext=COIL.filter(c=>c.key===k).some(extNet);
    add(ext?'warn':'error','D06','Coil '+k+' can never be energized','No combination of buttons and switches energizes this coil. A contact in its circuit may be in the wrong state, or a path is broken.'+(ext?' (A relay or solid-state device in the circuit is not simulated, so this may be a false alarm.)':''),'Trace the path from one supply terminal through the coil to the other; look for an N/O that nothing closes or an open terminal.',cu)}
   if(st[0].K[x])add(motor?'error':'warn','D07','Coil '+k+' energizes without any command',motor?'With every button released the coil is already on the moment power is applied, so the motor starts by itself: a safety hazard.':'With every button released the coil is already on the moment power is applied.','Put a start button (N/O) in the coil path and a hold-in contact in parallel with it.',cu)});

  if(!meta.partial){
   const rev=st.map(()=>[]);edges.forEach(([a,b])=>rev[b].push(a));
   keys.forEach((k,x)=>{if(!ever[x])return;const ok=new Uint8Array(st.length),q=[];st.forEach((s,i)=>{if(!s.K[x]){ok[i]=1;q.push(i)}});while(q.length){const i=q.pop();rev[i].forEach(j=>{if(!ok[j]){ok[j]=1;q.push(j)}})}
    const bad=st.findIndex((s,i)=>s.K[x]&&!ok[i]);if(bad>=0)add(PK.includes(x)?'error':'warn','D08','Coil '+k+' cannot be switched off once on','Once started, no button or switch can drop this coil, so the load can only be stopped by removing the supply.','Add a stop (N/C) button in series with the coil and its hold-in contact.',coilUids(k),tr(bad))})}

  /* hold-to-run: contactor drops as soon as the momentary button is released */
  const M=new Set(INP.map((x,j)=>x.mom?j:-1).filter(j=>j>=0));
  if(M.size&&st.length<=6000)PK.forEach(x=>{if(!ever[x])return;let latch=false,first=-1;
   for(let i=0;i<st.length&&!latch;i++){const s=st[i];if(!s.K[x])continue;if(first<0)first=i;const Ir=s.I.map((v,j)=>M.has(j)?0:v);if(Ir.join('')===s.I.join('')){latch=true;break}if(relax(Ir,s.K).K[x])latch=true}
   if(!latch)add('warn','D10','Coil '+keys[x]+' has no seal-in: runs only while a button is held','Whenever the momentary buttons are released the coil drops, so the motor runs only while Start is pressed (jog / hold-to-run).','Add an N/O auxiliary contact of '+keys[x]+' in parallel with the start button to hold the coil in, unless jogging is intended.',coilUids(keys[x]),first>=0?tr(first):{})});

  /* inputs that do nothing */
  const conn=(()=>{const p=[];for(let i=0;i<NN;i++)p[i]=i;const g=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x]}return x};EL.forEach(e=>p[g(e.na)]=g(e.nb));return g})();
  const coilComps=new Set(COIL.map(c=>conn(EL[c.idx].na)));
  if(!meta.partial)INP.forEach((inp,j)=>{if(PROTIN[j]||infl[j].some(Boolean))return;const e=EL.find(e=>e.t==='inp'&&e.i===j);if(!e||!coilComps.has(conn(e.na)))return;
   add('warn','D13','Input '+inp.name+' has no effect','Operating it never changes any coil. It may be bypassed by another branch or wired where nothing depends on it.','Check that it is in series with the coil path it should control.',[inp.c.uid])});
  if(COIL.some(c=>c.s.timer)||EL.some(e=>e.s&&e.s.delay))add('info','D15','Timers are not simulated','Timer coils and time-delay contacts are treated as instantaneous in the dry-run, so timing-dependent sequences (star-delta changeover, delayed stop) are checked for wiring only.','Review the timing logic by hand.',[]);
 }else if(COIL.length)add('info','D00','Control logic not checked','A supply is needed to see which coils energize.','Add the control supply.',[]);

 meta.ms=Math.round(performance.now()-t0);
 const ord={error:0,warn:1,info:2};out.sort((a,b)=>ord[a.sev]-ord[b.sev]||(a.id<b.id?-1:a.id>b.id?1:0));
 return{issues:out,meta};
}

/* ================= REPORT PANEL ================= */
let last=null,filt='all';
const COL={error:'#e94560',warn:'#f1c40f',info:'#4fc3f7'},LAB={error:'ERROR',warn:'WARNING',info:'NOTE'};
const bs=()=>'background:#1b2445;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit';
function toText(res){return res.issues.map(x=>'['+LAB[x.sev]+'] '+x.id+' '+x.title+'\n  '+x.why+(x.trace?'\n  Reproduce: '+x.trace.join(' -> '):'')+'\n  Fix: '+x.fix).join('\n\n')}
function show(api,res){
 last=res;
 let p=document.getElementById('cbpv');
 if(!p){p=document.createElement('div');p.id='cbpv';p.style.cssText='position:fixed;top:54px;right:10px;bottom:46px;width:450px;max-width:94vw;z-index:60;background:var(--panel);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;box-shadow:0 10px 34px #000a;font:12.5px "Segoe UI",Roboto,sans-serif;color:var(--text)';document.body.appendChild(p)}
 const I=res.issues,n=s=>I.filter(x=>x.sev===s).length,m=res.meta,ne=n('error'),nw=n('warn');
 const verdict=ne?['FAIL','#e94560']:nw?['PASS WITH WARNINGS','#f1c40f']:['PASS','#2ecc71'];
 const chip=(k,t,c)=>'<button data-f="'+k+'" style="'+bs()+';border-color:'+(filt===k?c:'var(--line)')+';'+(filt===k?'background:'+c+'33':'')+'">'+t+'</button>';
 const shown=I.map((x,i)=>[x,i]).filter(([x])=>filt==='all'||x.sev===filt);
 p.innerHTML='<div style="padding:10px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px"><b style="font-size:14px">Circuit check</b><span style="background:'+verdict[1]+'22;color:'+verdict[1]+';border:1px solid '+verdict[1]+';border-radius:10px;padding:1px 9px;font-weight:600;font-size:11px">'+verdict[0]+'</span><span style="flex:1"></span><button data-a="cp" style="'+bs()+'">Copy</button><button data-a="re" style="'+bs()+'">Re-run</button><button data-a="x" style="'+bs()+'">✕</button></div>'+
 '<div style="padding:8px 12px;border-bottom:1px solid var(--line)"><div style="display:flex;gap:6px;flex-wrap:wrap">'+chip('all','All '+I.length,'#8899cc')+chip('error',ne+' errors',COL.error)+chip('warn',nw+' warnings',COL.warn)+chip('info',n('info')+' notes',COL.info)+'</div>'+
 '<div style="color:var(--dim);margin-top:6px;font-size:11.5px">'+m.comps+' components · '+m.wires+' wires · '+m.nets+' nets'+(m.states?' · dry-run '+m.states+' states, '+m.inputs+' inputs, '+m.coils+' coils'+(m.partial?' (partial: state limit reached)':''):'')+' · '+m.ms+' ms · engine v'+m.version+'. Rule-based aid; it does not replace engineering review.</div></div>'+
 '<div style="overflow:auto;flex:1;padding:8px 10px;display:flex;flex-direction:column;gap:8px">'+(shown.length?shown.map(([x,i])=>'<div data-i="'+i+'" style="cursor:pointer;background:var(--panel2);border-left:4px solid '+COL[x.sev]+';border-radius:6px;padding:8px 10px"><div style="display:flex;gap:6px;align-items:baseline"><span style="color:'+COL[x.sev]+';font-weight:700;font-size:10.5px">'+LAB[x.sev]+'</span><span style="color:var(--dim);font-size:10.5px">'+x.id+' · '+esc(x.cat)+'</span></div><div style="font-weight:600;margin-top:2px">'+esc(x.title)+'</div><div style="margin-top:3px">'+esc(x.why)+'</div>'+(x.trace?'<div style="margin-top:4px;color:var(--dim)"><b>To reproduce:</b> '+x.trace.map(esc).join(' → ')+'</div>':'')+'<div style="margin-top:4px;color:#7fe0a0"><b>Fix:</b> '+esc(x.fix)+'</div></div>').join(''):'<div style="padding:20px;text-align:center;color:#7fe0a0">'+(I.length?'Nothing in this category.':'No problems found.')+'</div>')+'</div>';
 p.onclick=e=>{
  const a=e.target.closest('[data-a]');if(a){const v=a.dataset.a;if(v==='x')p.remove();else if(v==='re')run2(api);else if(v==='cp'){const t=toText(last);(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>{a.textContent='Copied'},()=>{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');a.textContent='Copied'}catch(_){}ta.remove()})}return}
  const fl=e.target.closest('[data-f]');if(fl){filt=fl.dataset.f;show(api,last);return}
  const d=e.target.closest('[data-i]');if(d){const x=I[+d.dataset.i];api.focus(x.uids,x.pos)}};
}
function run2(api){try{show(api,run(api))}catch(e){console.error(e);alert('Validator error: '+e.message)}}
window.CBPValidator={run:run2,check:run,version:VERSION};
})();
