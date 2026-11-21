create extension if not exists pgcrypto;

create table if not exists public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 username text not null,
 display_name text not null default 'Ouvinte',
 bio text not null default '',
 avatar_url text,
 avatar_path text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint profiles_username_length check(char_length(username) between 3 and 24),
 constraint profiles_display_name_length check(char_length(display_name) between 2 and 40),
 constraint profiles_bio_length check(char_length(bio)<=160)
);
create unique index if not exists profiles_username_lower_idx on public.profiles(lower(username));

create table if not exists public.tracks (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 title text not null,
 artist text not null,
 description text not null default '',
 audio_path text not null,
 audio_url text not null,
 cover_path text,
 cover_url text,
 status text not null default 'published' check(status in ('published','hidden')),
 created_at timestamptz not null default now(),
 constraint tracks_title_length check(char_length(title) between 2 and 80),
 constraint tracks_artist_length check(char_length(artist) between 1 and 80),
 constraint tracks_description_length check(char_length(description)<=500)
);
create index if not exists tracks_created_at_idx on public.tracks(created_at desc);
create index if not exists tracks_user_id_idx on public.tracks(user_id);

create table if not exists public.reports (
 id uuid primary key default gen_random_uuid(),
 reporter_id uuid not null references public.profiles(id) on delete cascade,
 track_id uuid not null references public.tracks(id) on delete cascade,
 reason text not null,
 created_at timestamptz not null default now(),
 constraint reports_reason_length check(char_length(reason) between 3 and 500)
);

create or replace function public.handle_sonora_new_user()
returns trigger language plpgsql security definer set search_path=public
as $$
declare
 base_username text;
 chosen_username text;
 chosen_name text;
begin
 base_username:=lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username',split_part(coalesce(new.email,''),'@',1),'ouvinte'),'[^a-z0-9_]+','_','g'));
 base_username:=trim(both '_' from base_username);
 if char_length(base_username)<3 then base_username:='ouvinte'; end if;
 base_username:=left(base_username,24);
 chosen_username:=base_username;
 if exists(select 1 from public.profiles p where lower(p.username)=lower(chosen_username)) then
  chosen_username:=left(base_username,17)||'_'||substr(replace(new.id::text,'-',''),1,6);
 end if;
 chosen_name:=left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'),''),chosen_username),40);
 if char_length(chosen_name)<2 then chosen_name:='Ouvinte'; end if;
 insert into public.profiles(id,username,display_name) values(new.id,chosen_username,chosen_name) on conflict(id) do nothing;
 return new;
end;
$$;
drop trigger if exists on_sonora_auth_user_created on auth.users;
create trigger on_sonora_auth_user_created after insert on auth.users for each row execute procedure public.handle_sonora_new_user();

alter table public.profiles enable row level security;
alter table public.tracks enable row level security;
alter table public.reports enable row level security;

revoke all on public.profiles from anon,authenticated;
revoke all on public.tracks from anon,authenticated;
revoke all on public.reports from anon,authenticated;
grant select on public.profiles to anon,authenticated;
grant update(username,display_name,bio,avatar_url,avatar_path,updated_at) on public.profiles to authenticated;
grant select on public.tracks to anon,authenticated;
grant insert,update,delete on public.tracks to authenticated;
grant insert on public.reports to authenticated;

drop policy if exists "Sonora profiles public read" on public.profiles;
create policy "Sonora profiles public read" on public.profiles for select to anon,authenticated using(true);
drop policy if exists "Sonora users update own profile" on public.profiles;
create policy "Sonora users update own profile" on public.profiles for update to authenticated using((select auth.uid())=id) with check((select auth.uid())=id);

drop policy if exists "Sonora published tracks public read" on public.tracks;
create policy "Sonora published tracks public read" on public.tracks for select to anon,authenticated using(status='published' or (select auth.uid())=user_id);
drop policy if exists "Sonora users insert own tracks" on public.tracks;
create policy "Sonora users insert own tracks" on public.tracks for insert to authenticated with check((select auth.uid())=user_id);
drop policy if exists "Sonora users update own tracks" on public.tracks;
create policy "Sonora users update own tracks" on public.tracks for update to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
drop policy if exists "Sonora users delete own tracks" on public.tracks;
create policy "Sonora users delete own tracks" on public.tracks for delete to authenticated using((select auth.uid())=user_id);
drop policy if exists "Sonora users report tracks" on public.reports;
create policy "Sonora users report tracks" on public.reports for insert to authenticated with check((select auth.uid())=reporter_id);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('sonora-media','sonora-media',true,26214400,array['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/ogg','audio/mp4','audio/aac','audio/flac','audio/webm','image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "Sonora media public read" on storage.objects;
create policy "Sonora media public read" on storage.objects for select to anon,authenticated using(bucket_id='sonora-media');
drop policy if exists "Sonora users upload own media" on storage.objects;
create policy "Sonora users upload own media" on storage.objects for insert to authenticated with check(bucket_id='sonora-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists "Sonora users update own media" on storage.objects;
create policy "Sonora users update own media" on storage.objects for update to authenticated using(bucket_id='sonora-media' and (storage.foldername(name))[1]=(select auth.uid())::text) with check(bucket_id='sonora-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists "Sonora users delete own media" on storage.objects;
create policy "Sonora users delete own media" on storage.objects for delete to authenticated using(bucket_id='sonora-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
