import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || 'https://pfamxddjvfddghdcceth.supabase.co';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_TduWvy9rlfwYPCAQxbEjmQ_-fImeUlE';
const supabase = createClient(url, key, {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
const APP_CACHE = 'shuttle-desk-demo-v1';
const PENDING = 'shuttle-pending-v2';
// Authentication uses confirmed internal email aliases, never SMS.
// Phone numbers remain the only identifiers shown to users.
const phoneEmail=phone=>`p${phone.replace(/\D/g,'')}@shuttledesk.example.com`;

let activeUser = null;
let revision = null;
let saving = false;
let saveTimer;

function status(text, warning=false) {
  let target=document.querySelector('#cloud-status');
  if (!target) {
    target=document.createElement('div');target.id='cloud-status';
    target.style.cssText='position:fixed;bottom:12px;right:15px;z-index:9;border-radius:10px;padding:9px 14px;background:white;box-shadow:0 3px 18px #132b3922;font-size:12px;font-weight:bold';
    document.body.append(target);
  }
  target.style.color=warning?'#b45309':'#137c85';target.textContent=text;
}

function loginScreen(message='') {
  document.body.className='auth-locked';
  let box=document.querySelector('#login-ui');
  if (!box) {
    box=document.createElement('div');box.id='login-ui';
    box.innerHTML=`<div class="login-card"><div class="login-logo">⇄</div><h1>ShuttleDesk</h1><p>התחברות למערכת ניהול ההסעות</p><form id="login-form"><label>מספר טלפון</label><input name="phone" type="tel" autocomplete="username" required placeholder="+972501234567" dir="ltr"><label>קוד אישי</label><input name="password" type="password" autocomplete="current-password" required minlength="6" placeholder="הקוד שקיבלת מהמנהל"><button type="submit">כניסה למערכת</button><div id="login-error" role="alert"></div></form><small>אין הרשמה עצמאית. המנהל יוצר חשבונות למשתמשים.</small></div>`;
    let style=document.createElement('style');style.textContent=`body.auth-loading .app,body.auth-locked .app{display:none!important}#login-ui{position:fixed;inset:0;background:#f3f7f8;display:grid;place-items:center;padding:20px;font-family:Arial,sans-serif;direction:rtl}#login-ui .login-card{background:#fff;box-shadow:0 16px 50px #18323d13;padding:34px;border-radius:22px;width:min(410px,100%);text-align:center}#login-ui .login-logo{display:grid;place-items:center;background:#158c8e;color:#fff;width:58px;height:58px;margin:auto;border-radius:16px;font-size:32px}#login-ui h1{font-size:29px;margin:14px 0 6px;color:#173540}#login-ui p{color:#78909a;margin:0 0 28px}#login-ui form{display:grid;gap:10px;text-align:right}#login-ui label{font-weight:700;font-size:12px;color:#53717c}#login-ui input{padding:13px;border:1px solid #d5e1e5;border-radius:10px;font-size:16px}#login-ui button{background:#137c85;color:white;border:0;border-radius:10px;padding:14px;margin-top:12px;font-weight:bold}#login-ui small{display:block;color:#91a3ab;margin-top:24px}#login-error{min-height:18px;color:#ba4c43;text-align:center;font-size:12px}`;
    document.head.append(style);document.body.append(box);
    box.querySelector('#login-form').addEventListener('submit',login);
  }
  box.style.display='grid';box.querySelector('#login-error').textContent=message;
  status('התחברות נדרשת',true);
}

async function login(event) {
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button');button.disabled=true;button.textContent='מתחבר...';
  const phone=form.elements.phone.value.replace(/[\s()-]/g,'');
  const password=form.elements.password.value;
  const {error}=await supabase.auth.signInWithPassword({email:phoneEmail(phone),password});
  button.disabled=false;button.textContent='כניסה למערכת';
  if (error) return loginScreen('מספר טלפון או קוד אישי שגויים, או שהחשבון טרם הופעל');
  await loadState();
}

async function loadState() {
  status('⟳ טוען נסיעות מהשרת');
  const {data:auth}=await supabase.auth.getUser();
  if (!auth?.user) return loginScreen();
  const {data,error}=await supabase.rpc('read_shuttle_state');
  if (error) return loginScreen('המשתמש עדיין לא שויך לתפקיד. פנה למנהל.');
  activeUser={id:data.user_id,role:data.role};revision=Number(data.revision);
  window.loadCloudState(data.state);
  window.setActualRole(data.role==='driver'?'driver:'+activeUser.id:data.role);
  document.body.className='auth-ready';
  document.querySelector('#login-ui')?.remove();
  const signout=document.createElement('button');signout.className='btn secondary';signout.textContent='יציאה';signout.onclick=async()=>{await supabase.auth.signOut();activeUser=null;revision=null;loginScreen()};
  const top=document.querySelector('.topright');top.querySelector('#logout-button')?.remove();signout.id='logout-button';top.append(signout);
  top.querySelector('#create-account-button')?.remove();
  top.querySelector('#import-data-button')?.remove();
  if (data.role==='manager') {
    const create=document.createElement('button');create.id='create-account-button';create.className='btn ghost';create.textContent='＋ משתמש';
    create.onclick=()=>openUserForm('driver');top.append(create);
    const importer=document.createElement('button');importer.id='import-data-button';importer.className='btn secondary';importer.textContent='↑ ייבוא נתונים';importer.onclick=importShuttleData;top.append(importer);
  }
  status('✓ מסונכרן עם השרת');
  if (localStorage.getItem(PENDING)) flush();
}

async function flush() {
  if (saving||revision===null||!activeUser||activeUser.role==='driver'||!navigator.onLine)return;
  const pending=localStorage.getItem(PENDING);if(!pending)return;
  saving=true;status('⟳ שומר שינויים');
  try {
    const {data,error}=await supabase.rpc('save_shuttle_state',{next_state:JSON.parse(pending),expected_revision:revision});
    if(error)throw error;
    revision=Number(data);
    if(localStorage.getItem(PENDING)===pending)localStorage.removeItem(PENDING);
    status('✓ השינויים נשמרו');
  } catch(error) {
    if(/Revision conflict|Manager approval|required/i.test(error.message)){
      localStorage.removeItem(PENDING);
      status('⚠ השינוי נדחה. טוען מידע מעודכן',true);
      await loadState();
    }else status('⚠ השינויים ממתינים לחיבור',true);
  } finally {
    saving=false;
    if(localStorage.getItem(PENDING)&&revision!==null)setTimeout(flush,800);
  }
}

window.cloudSave=state=>{
  if(!activeUser||activeUser.role==='driver')return;
  localStorage.setItem(PENDING,JSON.stringify(state));clearTimeout(saveTimer);
  saveTimer=setTimeout(flush,350);
};

async function importShuttleData(){
  if(activeUser?.role!=='manager')return;
  const picker=document.createElement('input');picker.type='file';picker.accept='.json,application/json';
  picker.onchange=async()=>{
    try{
      const payload=JSON.parse(await picker.files[0].text());
      if(payload.format!=='shuttle-desk-import-v1'||!Array.isArray(payload.passengers)||!Array.isArray(payload.trips)||!Array.isArray(payload.destinations))throw Error('קובץ ייבוא לא תקין');
      const old=window.getShuttleState();
      const next=structuredClone(old);
      const importedPassengers=new Map();
      for(const p of payload.passengers){
        if(typeof p.id!=='string'||typeof p.name!=='string'||typeof p.address!=='string'||typeof p.phone!=='string')throw Error('רשומת נוסע לא תקינה');
        let target=next.passengers.find(x=>x.id===p.id)||next.passengers.find(x=>x.name.trim()===p.name.trim() && (!p.phone||!x.phone||x.phone.replace(/\D/g,'')===p.phone.replace(/\D/g,'')));
        if(!target){target={...p};next.passengers.push(target)}
        importedPassengers.set(p.id,target.id);
      }
      for(const dest of payload.destinations){if(typeof dest!=='string')throw Error('יעד לא תקין');if(!next.destinations.includes(dest))next.destinations.push(dest)}
      let added=0;
      for(const trip of payload.trips){
        if(typeof trip.id!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(trip.date)||!/^\d\d:\d\d$/.test(trip.time)||!Array.isArray(trip.passengerIds)||!['planned','complete'].includes(trip.status))throw Error('רשומת נסיעה לא תקינה');
        if(next.trips.some(x=>x.id===trip.id))continue;
        const matchDriver=next.drivers.find(d=>d.name.trim()===(trip.sourceDriver||'').trim());
        next.trips.push({...trip,passengerIds:trip.passengerIds.map(id=>importedPassengers.get(id)).filter(Boolean),driverId:matchDriver?.id||null,ack:false});added++;
      }
      if(JSON.stringify(next).length>900000)throw Error('הקובץ גדול מדי');
      if(!confirm(`לייבא ${payload.passengers.length} נוסעים ו-${added} נסיעות חדשות?\nהנתונים הקיימים יישמרו ונסיעות שכבר יובאו לא יוכפלו.`))return;
      window.loadCloudState(next);window.cloudSave(next);status('⟳ הייבוא נשלח לשמירה');
    }catch(e){alert('הייבוא נכשל: '+e.message)}
  };
  picker.click();
}

window.driverAction=async(id,action)=>{
  if(!activeUser||activeUser.role!=='driver')return;
  status('⟳ מעדכן סטטוס');
  const {error}=await supabase.rpc('driver_trip_action',{trip_id:id,action});
  if(error)status('⚠ הפעולה נכשלה, נא לרענן',true);
  await loadState();
};

// The trip form selects passengers from the saved passenger directory.
// Make an empty directory actionable and show the number selected.
const originalOpenTrip=window.openTrip;
window.openTrip=function(...args){
  originalOpenTrip(...args);
  const form=document.querySelector('#tripForm');
  if(!form)return;
  const list=form.querySelector('.checklist');
  if(!list)return;
  const boxes=[...list.querySelectorAll('input[name="passengerIds"]')];
  if(!boxes.length){
    list.innerHTML='<div style="padding:16px;text-align:center;color:#526e77">עדיין אין נוסעים ברשימה.<br>יש להוסיף נוסעים לפני יצירת נסיעה.<br><button type="button" class="btn secondary sm" style="margin-top:12px" id="add-first-passenger">＋ הוספת נוסע</button></div>';
    list.querySelector('#add-first-passenger').onclick=()=>{window.closeModal();window.go('people')};
    return;
  }
  const count=document.createElement('div');
  count.style.cssText='font-weight:700;color:#137c85;margin-bottom:9px';
  list.before(count);
  const update=()=>{const number=boxes.filter(box=>box.checked).length;count.textContent=`נבחרו ${number} נוסעים מתוך ${boxes.length}`};
  boxes.forEach(box=>box.addEventListener('change',update));
  update();
};

function openUserForm(defaultRole='driver') {
  if(activeUser?.role!=='manager')return;
  const overlay=document.createElement('div');overlay.id='create-account-overlay';overlay.className='modalback';
  overlay.innerHTML=`<div class="modal" role="dialog" aria-modal="true"><div class="modalhead"><h2>יצירת משתמש חדש</h2><button type="button" class="close" id="close-account">×</button></div><form id="account-form"><div class="modalbody formgrid"><div class="formgroup"><label>שם מלא</label><input class="field" name="name" required minlength="2"></div><div class="formgroup"><label>מספר טלפון בינלאומי</label><input class="field" dir="ltr" type="tel" name="phone" required placeholder="+972501234567"></div><div class="formgroup"><label>תפקיד</label><select class="field" name="role"><option value="driver" ${defaultRole==='driver'?'selected':''}>נהג</option><option value="dispatcher" ${defaultRole==='dispatcher'?'selected':''}>סדרן</option></select></div><div class="formgroup"><label>סיסמה אישית (לפחות 8 תווים)</label><input class="field" type="password" name="password" required minlength="8" autocomplete="new-password"></div><p class="muted" style="grid-column:1/-1">מסור את פרטי הכניסה למשתמש בדרך פרטית. אל תשתמש בקוד קצר שקל לנחש.</p><div id="account-error" style="color:#b5483d;grid-column:1/-1"></div></div><div class="modalfoot"><button type="button" class="btn secondary" id="cancel-account">ביטול</button><button type="submit" class="btn">צור משתמש</button></div></form></div>`;
  document.body.append(overlay);
  const close=()=>overlay.remove();overlay.querySelector('#close-account').onclick=close;overlay.querySelector('#cancel-account').onclick=close;
  overlay.addEventListener('click',e=>{if(e.target===overlay)close()});
  overlay.querySelector('#account-form').onsubmit=async e=>{
    e.preventDefault();const form=e.currentTarget,button=form.querySelector('button[type=submit]');button.disabled=true;
    const fields=Object.fromEntries(new FormData(form));fields.phone=fields.phone.replace(/[\s()-]/g,'');
    const {data:{session}}=await supabase.auth.getSession();
    try {
      const response=await fetch('/api/create-user',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},body:JSON.stringify(fields)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'שגיאה ביצירת המשתמש');
      if(fields.role==='driver'){
        const state=window.getShuttleState();state.drivers.push({id:result.id,name:fields.name,phone:fields.phone});window.persistShuttle();
      }
      close();status('✓ המשתמש נוצר');
    }catch(err){overlay.querySelector('#account-error').textContent=err.message;button.disabled=false}
  };
}

const originalOpenEntity=window.openEntity;
window.openEntity=function(id){
  if(id===undefined&&document.querySelector('.tabs button.active')?.textContent?.includes('נהגים')){
    if(activeUser?.role==='manager')return openUserForm('driver');
    status('רק מנהל יכול להוסיף נהגים',true);return;
  }
  return originalOpenEntity(id);
};

window.addEventListener('online',()=>{if(activeUser)flush()});
const {data:{session}}=await supabase.auth.getSession();
if(session)await loadState();else loginScreen();
