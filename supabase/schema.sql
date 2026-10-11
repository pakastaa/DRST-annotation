-- Run this in Supabase Dashboard → SQL Editor. It stores data behind Supabase
-- Auth and never grants anonymous visitors access to task text or reviews.
create table if not exists public.annotation_tasks (
  trajectory_id text primary key,
  source text not null,
  target_character text not null,
  round_count integer not null check (round_count > 0),
  event_count integer not null default 0 check (event_count >= 0),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.annotation_events (
  event_id text primary key,
  trajectory_id text not null references public.annotation_tasks(trajectory_id) on delete cascade,
  round_id integer not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists annotation_events_trajectory_round_idx on public.annotation_events (trajectory_id, round_id);

create table if not exists public.annotation_reviews (
  user_id uuid not null references auth.users(id) on delete cascade,
  trajectory_id text not null references public.annotation_tasks(trajectory_id) on delete cascade,
  status text not null check (status in ('draft', 'submitted')),
  revision integer not null default 1 check (revision > 0),
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, trajectory_id)
);

alter table public.annotation_tasks enable row level security;
alter table public.annotation_events enable row level security;
alter table public.annotation_reviews enable row level security;

create policy "authenticated reviewers read tasks" on public.annotation_tasks for select to authenticated using (true);
create policy "authenticated reviewers read events" on public.annotation_events for select to authenticated using (true);
create policy "reviewers read own reviews" on public.annotation_reviews for select to authenticated using (auth.uid() = user_id);
create policy "reviewers add own reviews" on public.annotation_reviews for insert to authenticated with check (auth.uid() = user_id);
create policy "reviewers update own reviews" on public.annotation_reviews for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on public.annotation_tasks, public.annotation_events, public.annotation_reviews from anon;
grant select on public.annotation_tasks, public.annotation_events to authenticated;
grant select, insert, update on public.annotation_reviews to authenticated;
