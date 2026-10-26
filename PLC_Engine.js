(()=>{"use strict";
const create=post=>{
const CONTACTS=new Set(["NO","NC","P","N","EQ","GT","LT"]),OUTPUTS=new Set(["OTE","SET","RST","TON","TOF","TP","TONR","CTU","CTD","MOV","ADD","RES"]),TIMERS=new Set(["TON","TOF","TP","TONR"]),address=a=>typeof a=="string"&&/^[IQMTCD](?:[0-9]|[1-5][0-9]|6[0-3])$/.test(a);
const validate=program=>{
if(!program||!Array.isArray(program.rungs)||program.rungs.length>500)throw Error("Program must contain no more than 500 rungs.");
let size=0;const active=new WeakSet;
const checkContacts=(list,depth=0)=>{if(!Array.isArray(list)||depth>16||active.has(list))throw Error("Invalid, circular, or over-nested contact list.");active.add(list);for(const n of list){if(++size>5000||!n||typeof n!="object"||active.has(n))throw Error("Program has too many elements or a circular contact reference.");active.add(n);if(n.par){if(!Array.isArray(n.par)||!n.par.length)throw Error("Invalid parallel branch.");for(const branch of n.par)checkContacts(branch,depth+1)}else if(!CONTACTS.has(n.t)||!address(n.a)||(["EQ","GT","LT"].includes(n.t)&&!Number.isFinite(n.pt)))throw Error("Invalid contact instruction or address.");active.delete(n)}active.delete(list)};
for(const r of program.rungs){if(!r||typeof r!="object"||!Array.isArray(r.c)||!Array.isArray(r.o))throw Error("Invalid rung structure.");checkContacts(r.c);for(const o of r.o){if(++size>5000||!o||!OUTPUTS.has(o.t)||!address(o.a))throw Error("Invalid output instruction or address.");const validType=["OTE","SET","RST"].includes(o.t)?["Q","M"]:TIMERS.has(o.t)?["T"]:o.t=="CTU"||o.t=="CTD"?["C"]:o.t=="MOV"||o.t=="ADD"?["D"]:["T","C","D"];if(!validType.includes(o.a[0]))throw Error(`${o.t} cannot write ${o.a}.`);if(o.pt!=null&&(!Number.isFinite(o.pt)||o.pt<0)||([...TIMERS,"CTU","CTD"].includes(o.t)&&o.pt!=null&&o.pt<=0))throw Error(`${o.t} preset must be a positive finite number.`);if((o.t=="MOV"||o.t=="ADD")&&o.src!=null&&(typeof o.src!="string"||(o.src[0]=="#"?(!o.src.slice(1)||!Number.isFinite(Number(o.src.slice(1)))):!address(o.src))))throw Error("Invalid source operand.")}}
if(program.tags!=null&&(typeof program.tags!="object"||Array.isArray(program.tags)||Object.entries(program.tags).some(([a,t])=>!address(a)||typeof t!="string"||t.length>10)))throw Error("Invalid tag table.");
return program;
};
let prog=[],bits={},tm={},inp={},iv=0,t0=0,reg={},rinit={},edge={},scanNo=0;
const val=a=>{const l=a[0],t=tm[a];return l=="D"?reg[a]||0:l=="C"?(t?t.cnt:0):l=="T"?(t?t.acc:0):bits[a]?1:0};
const src=o=>o.src&&o.src[0]!="#"?val(o.src):o.src?Number(o.src.slice(1))||0:o.pt||0;
const cmp=n=>{const x=val(n.a),k=n.pt||0;return n.t=="EQ"?x==k:n.t=="GT"?x>k:x<k};
const ev=(list,path)=>{let r=list.length>0;for(let i=0;i<list.length;i++){const n=list[i],key=path+"/"+i;let v;if(n.par){v=false;for(let j=0;j<n.par.length;j++)if(ev(n.par[j],key+"/b"+j))v=true}else{const b=n.a[0]=="D"?!!val(n.a):!!bits[n.a],prev=!!edge[key];v=n.t=="EQ"||n.t=="GT"||n.t=="LT"?cmp(n):n.t=="NC"?!b:n.t=="P"?b&&!prev:n.t=="N"?!b&&prev:b;edge[key]=b}if(!v)r=false}return r};
const snapshot=()=>({b:{...bits},t:Object.fromEntries(Object.entries(tm).map(([a,t])=>[a,{...t}])),d:{...reg},trace:[],scan:scanNo});
const scan=dt=>{
for(const k in inp)bits[k]=inp[k];
const trace=[];
for(let i=0;i<prog.length;i++){const r=prog[i],p=ev(r.c,"r"+i),outputs=[];
for(const o of r.o){const a=o.a,pt=o.pt==null?1000:o.pt;
if(o.t=="OTE")bits[a]=p;
else if(o.t=="SET"){if(p)bits[a]=true}
else if(o.t=="RST"){if(p)bits[a]=false}
else if(o.t=="CTU"){const c=tm[a]||(tm[a]={cnt:0,q:false,p:false,pt:o.pt||1});if(p&&!c.p)c.cnt++;c.p=p;c.q=c.cnt>=c.pt;bits[a]=c.q}
else if(o.t=="RES"){if(p){const c=tm[a];if(c){c.cnt=c.d?c.pt:0;c.acc=0;c.q=false;c.p=false}bits[a]=false;if(a[0]=="D")reg[a]=0}}
else if(o.t=="CTD"){const c=tm[a]||(tm[a]={cnt:o.pt||1,pt:o.pt||1,d:1,q:false,p:false});if(p&&!c.p)c.cnt=Math.max(0,c.cnt-1);c.p=p;c.q=c.cnt<=0;bits[a]=c.q}
else if(o.t=="MOV"){if(p)reg[a]=src(o)}
else if(o.t=="ADD"){if(p){const value=(reg[a]||0)+src(o);if(!Number.isFinite(value))throw Error(`ADD result for ${a} is not finite.`);reg[a]=value}}
else{const t=tm[a]||(tm[a]={acc:0,q:false,p:false});
if(o.t=="TON"){if(p){t.acc=Math.min(pt,t.acc+dt);t.q=t.acc>=pt}else{t.acc=0;t.q=false}}
else if(o.t=="TONR"){if(p)t.acc=Math.min(pt,t.acc+dt);t.q=t.acc>=pt}
else if(o.t=="TOF"){if(p){t.q=true;t.acc=0}else if(t.q){t.acc+=dt;if(t.acc>=pt){t.q=false;t.acc=pt}}}
else{if(p&&!t.p&&!t.q){t.q=true;t.acc=0}if(t.q){t.acc+=dt;if(t.acc>=pt)t.q=false}t.p=p}
bits[a]=t.q}
const t=tm[a],value=a[0]=="D"?reg[a]||0:a[0]=="T"?(t&&t.acc||0):a[0]=="C"?(t&&t.cnt||0):!!bits[a];
outputs.push({address:a,type:o.t,enabled:p,value,acc:t&&t.acc||0,count:t&&t.cnt||0})}
trace.push({rung:i+1,power:p,outputs})}
scanNo++;
post({...snapshot(),trace});
};
const tick=()=>{const n=performance.now(),dt=Math.max(0,Math.min(100,n-t0));t0=n;scan(dt)};
return m=>{
if(!m||typeof m!="object")throw Error("Invalid engine command.");
if(m.cmd=="load"){clearInterval(iv);iv=0;validate({rungs:m.p||[],tags:m.tags});prog=m.p||[];bits={};tm={};reg={...rinit};inp={};edge={};scanNo=0;post(snapshot())}
else if(m.cmd=="in"){if(!address(m.a)||m.a[0]!="I"||typeof m.v!="boolean")throw Error("Input commands require an I address and a boolean value.");inp[m.a]=m.v}
else if(m.cmd=="step"){const dt=m.dt==null?20:m.dt;if(!Number.isFinite(dt)||dt<1||dt>60000)throw Error("Scan duration must be between 1 and 60000 ms.");scan(dt)}
else if(m.cmd=="reg"){if(!address(m.a)||m.a[0]!="D"||!Number.isFinite(m.v))throw Error("Register commands require a D address and a finite numeric value.");rinit[m.a]=m.v;reg[m.a]=m.v}
else if(m.cmd=="pause"){clearInterval(iv);iv=0}
else if(m.cmd=="run"){if(!iv){t0=performance.now();iv=setInterval(tick,20)}}
else if(m.cmd=="stop"||m.cmd=="reset"){clearInterval(iv);iv=0;bits={};inp={};tm={};reg={...rinit};edge={};post(snapshot())}
};
};
globalThis.PLCEngine=Object.freeze({version:2,create,validate:program=>{if(!program||typeof program!="object")throw Error("Invalid PLC program.");const engine=create(()=>{});engine({cmd:"load",p:program.rungs,tags:program.tags});return program}});
})();
