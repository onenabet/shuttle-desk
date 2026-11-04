-- ShuttleDesk: execute once in Supabase SQL Editor.
-- Phone/password accounts are created by the administrator, not public sign-up.

create table if not exists public.app_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text unique not null,
  name text not null,
  role text not null check (role in ('manager','dispatcher','driver')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists one_manager_per_app on public.app_profiles(role) where role = 'manager';

create table if not exists public.shuttle_state (
  id int primary key default 1 check (id = 1),
  state jsonb not null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.shuttle_state(id, state, revision)
values (1, '{"drivers":[],"passengers":[],"destinations":["יותם","חוף","פיקוד יותם"],"trips":[]}'::jsonb, 0)
on conflict (id) do nothing;

alter table public.app_profiles enable row level security;
alter table public.shuttle_state enable row level security;
revoke all on public.shuttle_state from anon, authenticated;
revoke all on public.app_profiles from anon;
grant select on public.app_profiles to authenticated;

create policy "profile self read" on public.app_profiles
for select to authenticated using (id = (select auth.uid()));

-- No direct client writes to shuttle_state or app_profiles.
-- All application data passes through these access-controlled functions.
create or replace function public.read_shuttle_state()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  user_role text;
  user_name text;
  s jsonb;
  rev bigint;
  my_trips jsonb;
  my_passengers jsonb;
begin
  select role, name into user_role, user_name from public.app_profiles where id = uid and active = true;
  if user_role is null then raise exception 'Not authorized'; end if;
  select state, revision into s, rev from public.shuttle_state where id = 1;
  if user_role = 'driver' then
    select coalesce(jsonb_agg(t), '[]'::jsonb) into my_trips
      from jsonb_array_elements(s->'trips') t where t->>'driverId' = uid::text;
    select coalesce(jsonb_agg(p), '[]'::jsonb) into my_passengers
      from jsonb_array_elements(s->'passengers') p
      where exists (
        select 1 from jsonb_array_elements(my_trips) t,
          jsonb_array_elements_text(t->'passengerIds') pid
        where pid = p->>'id'
      );
    s := jsonb_build_object(
      'drivers', jsonb_build_array(jsonb_build_object('id',uid::text,'name',user_name)),
      'passengers', my_passengers,
      'destinations', s->'destinations',
      'trips', my_trips
    );
  end if;
  return jsonb_build_object('state',s,'revision',rev,'role',user_role,'user_id',uid);
end;
$$;

create or replace function public.save_shuttle_state(next_state jsonb, expected_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  user_role text;
  old_state jsonb;
  old_revision bigint;
  incoming jsonb;
  old_trip jsonb;
  previous_status text;
  next_status text;
begin
  select role into user_role from public.app_profiles where id = auth.uid() and active = true;
  if user_role not in ('manager','dispatcher') or user_role is null then raise exception 'Not authorized'; end if;
  if next_state is null or jsonb_typeof(next_state) <> 'object'
    or jsonb_typeof(next_state->'trips') <> 'array'
    or jsonb_typeof(next_state->'passengers') <> 'array'
    or jsonb_typeof(next_state->'drivers') <> 'array'
    or jsonb_typeof(next_state->'destinations') <> 'array'
    or pg_column_size(next_state) > 1000000 then raise exception 'Invalid state'; end if;
  select state, revision into old_state, old_revision from public.shuttle_state where id = 1 for update;
  if expected_revision <> old_revision then raise exception 'Revision conflict'; end if;

  -- A dispatcher may create/edit rides, but only a manager can finalize or cancel.
  if user_role = 'dispatcher' then
    for incoming in select * from jsonb_array_elements(next_state->'trips') loop
      next_status := incoming->>'status';
      select t->>'status' into previous_status from jsonb_array_elements(old_state->'trips') t
        where t->>'id' = incoming->>'id' limit 1;
      if (next_status in ('complete','cancelled') and next_status is distinct from previous_status)
        or (previous_status in ('complete','cancelled') and next_status is distinct from previous_status)
      then raise exception 'Manager approval required'; end if;
    end loop;
    for old_trip in select * from jsonb_array_elements(old_state->'trips') loop
      if old_trip->>'status' in ('complete','cancelled')
        and not exists (select 1 from jsonb_array_elements(next_state->'trips') t where t->>'id'=old_trip->>'id')
      then raise exception 'Cannot remove finalized trips'; end if;
    end loop;
  end if;

  update public.shuttle_state set state = next_state, revision = revision+1, updated_at=now() where id=1;
  return old_revision+1;
end;
$$;

create or replace function public.driver_trip_action(trip_id text, action text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  uid text := auth.uid()::text;
  user_role text;
  old_state jsonb;
  old_revision bigint;
  ride jsonb;
  updated_ride jsonb;
  rewritten jsonb;
begin
  select role into user_role from public.app_profiles where id=auth.uid() and active=true;
  if user_role <> 'driver' or user_role is null then raise exception 'Not authorized'; end if;
  if action not in ('ack','done','no_show') then raise exception 'Invalid action'; end if;
  select state, revision into old_state,old_revision from public.shuttle_state where id=1 for update;
  select t into ride from jsonb_array_elements(old_state->'trips') t
    where t->>'id'=trip_id and t->>'driverId'=uid limit 1;
  if ride is null then raise exception 'Trip not assigned'; end if;
  if action='ack' then
    updated_ride := jsonb_set(ride, '{ack}', 'true'::jsonb);
  elsif action='done' and ride->>'status'='planned' then
    updated_ride := jsonb_set(ride, '{status}', '"awaiting"'::jsonb);
  elsif action='no_show' and ride->>'status'='planned' then
    updated_ride := jsonb_set(ride, '{status}', '"no_show"'::jsonb);
  else raise exception 'Invalid trip state'; end if;
  select jsonb_agg(case when t->>'id'=trip_id then updated_ride else t end)
    into rewritten from jsonb_array_elements(old_state->'trips') t;
  update public.shuttle_state set state=jsonb_set(old_state,'{trips}',rewritten),revision=revision+1,updated_at=now() where id=1;
  return old_revision+1;
end;
$$;

revoke all on function public.read_shuttle_state() from public, anon;
revoke all on function public.save_shuttle_state(jsonb,bigint) from public, anon;
revoke all on function public.driver_trip_action(text,text) from public, anon;
grant execute on function public.read_shuttle_state() to authenticated;
grant execute on function public.save_shuttle_state(jsonb,bigint) to authenticated;
grant execute on function public.driver_trip_action(text,text) to authenticated;
