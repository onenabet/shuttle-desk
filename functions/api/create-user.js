import { createClient } from '@supabase/supabase-js';

const json = (body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const normalizePhone=value=>{
  if(typeof value!=='string')return '';
  const clean=value.replace(/[\s()\-]/g,'');
  if(/^05\d{8}$/.test(clean))return '+972'+clean.slice(1);
  if(/^972\d{9}$/.test(clean))return '+'+clean;
  return clean;
};

export async function onRequestPost({request,env}) {
  if (!env.SUPABASE_SECRET_KEY || !env.SUPABASE_URL) return json({error:'הגדרות השרת חסרות'},503);
  const token=(request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
  if(!token)return json({error:'Unauthorized'},401);
  const admin=createClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
  // Verify the caller's access token against Supabase Auth using server-side credentials.
  // This does not depend on an optional publishable-key runtime binding.
  const {data:{user},error:authError}=await admin.auth.getUser(token);
  if(authError||!user)return json({error:'Unauthorized'},401);
  const {data:manager,error:profileLookupError}=await admin.from('app_profiles').select('role,active').eq('id',user.id).maybeSingle();
  if(profileLookupError)return json({error:'שגיאה בבדיקת הרשאות'},500);
  if(manager?.role!=='manager'||!manager.active)return json({error:'Forbidden'},403);
  let input;
  try {input=await request.json()} catch{return json({error:'Invalid JSON'},400)}
  const {name,phone,password,role}=input;
  const normalizedPhone=normalizePhone(phone);
  if(typeof name!=='string'||name.trim().length<2||name.length>100)return json({error:'יש להזין שם מלא (לפחות 2 תווים)'},400);
  if(!/^\+[1-9]\d{7,14}$/.test(normalizedPhone))return json({error:'מספר טלפון לא תקין. לדוגמה: 0501234567 או +972501234567'},400);
  if(typeof password!=='string'||password.length<8||password.length>128)return json({error:'הסיסמה חייבת להכיל 8 תווים לפחות'},400);
  if(!['driver','dispatcher'].includes(role))return json({error:'תפקיד משתמש לא תקין'},400);
  const email=`p${normalizedPhone.replace(/\D/g,'')}@shuttledesk.example.com`;
  const {data:created,error:createError}=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name:name.trim()}});
  if(createError)return json({error:createError.message?.includes('already')?'מספר הטלפון כבר רשום במערכת':'לא ניתן ליצור משתמש. בדוק את הפרטים ונסה שוב.'},400);
  const {error:profileError}=await admin.from('app_profiles').insert({id:created.user.id,phone:normalizedPhone,name:name.trim(),role});
  if(profileError){await admin.auth.admin.deleteUser(created.user.id);return json({error:'Profile creation failed'},500)}
  return json({id:created.user.id,name:name.trim(),phone:normalizedPhone,role},201);
}
