-- Agent Mission Control — Supabase şeması.
-- Tablolara doğrudan erişim RLS ile tamamen kapalıdır; tek kapı, token doğrulayan
-- SECURITY DEFINER fonksiyonlardır. Token panel_secrets tablosunda tutulur.

create table if not exists panel_state (
  id int primary key default 1,
  state jsonb,
  updated_at timestamptz default now()
);

create table if not exists panel_commands (
  id bigserial primary key,
  payload jsonb not null,
  status text not null default 'new',
  created_at timestamptz default now()
);

create table if not exists panel_secrets (
  id int primary key default 1,
  token text not null
);

alter table panel_state enable row level security;
alter table panel_commands enable row level security;
alter table panel_secrets enable row level security;

create or replace function panel_check(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or not exists (select 1 from panel_secrets where token = p_token) then
    raise exception 'unauthorized';
  end if;
end $$;

create or replace function state_put(p_token text, p_state jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform panel_check(p_token);
  insert into panel_state (id, state, updated_at) values (1, p_state, now())
  on conflict (id) do update set state = excluded.state, updated_at = now();
end $$;

create or replace function state_get(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform panel_check(p_token);
  select state into result from panel_state where id = 1;
  return result;
end $$;

create or replace function command_add(p_token text, p_payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform panel_check(p_token);
  insert into panel_commands (payload) values (p_payload);
end $$;

create or replace function commands_pop(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform panel_check(p_token);
  with popped as (
    update panel_commands set status = 'done'
    where status = 'new'
    returning payload
  )
  select coalesce(jsonb_agg(payload), '[]'::jsonb) into result from popped;
  return result;
end $$;

revoke all on panel_state, panel_commands, panel_secrets from anon, authenticated;
grant execute on function state_put(text, jsonb) to anon;
grant execute on function state_get(text) to anon;
grant execute on function command_add(text, jsonb) to anon;
grant execute on function commands_pop(text) to anon;
