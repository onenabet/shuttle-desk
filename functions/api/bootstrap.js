import { createClient } from '@supabase/supabase-js';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});

export async function onRequestPost({request,env}) {
  if(!env.SUPABASE_URL||!env.SUPABASE_SECRET_KEY||!env.BOOTSTRAP_TOKEN||env.BOOTSTRAP_TOKEN.length<24)
    return json({error:'Bootstrap is not configured'},503);
  const submitted=request.headers.get('X-Bootstrap-Token')||'';
  const a=new TextEncoder().encode(submitted),b=new TextEncoder().encode(env.BOOTSTRAP_TOKEN);
  if(a.length!==b.length)return json({error:'Invalid setup token'},403);
  let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];
  if(mismatch)return json({error:'Invalid setup token'},403);
  const admin=createClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {count,error:countError}=await admin.from('app_profiles').select('id',{count:'exact',head:true}).eq('role','manager');
  if(countError)return json({error:'Setup failed'},500);
  if(count>0)return json({error:'Manager already exists'},409);
  let input;try{input=await request.json()}catch{return json({error:'Invalid request'},400)}
  const {name,phone,password}=input;
  if(typeof name!=='string'||name.trim().length<2||name.length>100||
     typeof phone!=='string'||!/^\+[1-9]\d{7,14}$/.test(phone)||
     typeof password!=='string'||password.length<8||password.length>128)
    return json({error:'Invalid details'},400);
  const email=`p${phone.replace(/\D/g,'')}@shuttledesk.example.com`;
  const {data:created,error:createError}=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name:name.trim()}});
  if(createError)return json({error:'Could not create manager'},400);
  const {error:profileError}=await admin.from('app_profiles').insert({id:created.user.id,phone,name:name.trim(),role:'manager'});
  if(profileError){await admin.auth.admin.deleteUser(created.user.id);return json({error:'Could not save manager'},500)}
  return json({created:true},201);
}
