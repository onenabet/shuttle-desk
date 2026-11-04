import { createClient } from '@supabase/supabase-js';

const json = (body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});

export async function onRequestPost({request,env}) {
  if (!env.SUPABASE_SECRET_KEY || !env.SUPABASE_URL) return json({error:'Server setup incomplete'},503);
  const token=(request.headers.get('Authorization')||'').replace(/^Bearer /i,'');
  if(!token)return json({error:'Unauthorized'},401);
  const publicClient=createClient(env.SUPABASE_URL,env.SUPABASE_PUBLISHABLE_KEY);
  const admin=createClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
  const {data:{user},error:authError}=await publicClient.auth.getUser(token);
  if(authError||!user)return json({error:'Unauthorized'},401);
  const {data:manager}=await admin.from('app_profiles').select('role,active').eq('id',user.id).maybeSingle();
  if(manager?.role!=='manager'||!manager.active)return json({error:'Forbidden'},403);
  let input;
  try {input=await request.json()} catch{return json({error:'Invalid JSON'},400)}
  const {name,phone,password,role}=input;
  if(typeof name!=='string'||name.trim().length<2||name.length>100||
     typeof phone!=='string'||!/^\+[1-9]\d{7,14}$/.test(phone)||
     typeof password!=='string'||password.length<8||password.length>128||
     !['driver','dispatcher'].includes(role))return json({error:'Invalid user details'},400);
  const email=`p${phone.replace(/\D/g,'')}@shuttledesk.example.com`;
  const {data:created,error:createError}=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name:name.trim()}});
  if(createError)return json({error:'Could not create user'},400);
  const {error:profileError}=await admin.from('app_profiles').insert({id:created.user.id,phone,name:name.trim(),role});
  if(profileError){await admin.auth.admin.deleteUser(created.user.id);return json({error:'Profile creation failed'},500)}
  return json({id:created.user.id,name:name.trim(),phone,role},201);
}
