create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (char_length(username) between 3 and 32),
  display_name text not null check (char_length(display_name) between 1 and 50),
  account_type text not null default 'person' check (account_type in ('person', 'brand')),
  bio text not null default '' check (char_length(bio) <= 280),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.communities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  name text not null check (char_length(name) between 2 and 60),
  description text not null check (char_length(description) between 1 and 280),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.community_members (
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (community_id, user_id)
);

create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles (id) on delete cascade,
  community_id uuid not null references public.communities (id) on delete cascade,
  body text not null default '' check (char_length(body) <= 500),
  tags text[] not null default '{}',
  media_path text,
  created_at timestamptz not null default now(),
  check (char_length(btrim(body)) > 0 or media_path is not null),
  check (cardinality(tags) <= 10)
);

create table public.post_likes (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.saved_posts (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index posts_feed_order_idx on public.posts (created_at desc, id desc);
create index posts_author_feed_idx on public.posts (author_id, created_at desc, id desc);
create index posts_community_feed_idx on public.posts (community_id, created_at desc, id desc);
create index comments_post_order_idx on public.comments (post_id, created_at asc);
create index community_members_user_idx on public.community_members (user_id, community_id);
create index follows_following_idx on public.follows (following_id, follower_id);

alter table public.profiles enable row level security;
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.follows enable row level security;
alter table public.posts enable row level security;
alter table public.post_likes enable row level security;
alter table public.saved_posts enable row level security;
alter table public.comments enable row level security;

create policy "Profiles are public"
  on public.profiles for select to anon, authenticated using (true);
create policy "Users update their profile"
  on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "Communities are public"
  on public.communities for select to anon, authenticated using (true);
create policy "Signed-in users create communities"
  on public.communities for insert to authenticated with check (created_by = (select auth.uid()));
create policy "Community owners update communities"
  on public.communities for update to authenticated using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));
create policy "Community owners delete communities"
  on public.communities for delete to authenticated using (created_by = (select auth.uid()));

create policy "Community membership counts are public"
  on public.community_members for select to authenticated using (true);
create policy "Users join communities"
  on public.community_members for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users leave communities"
  on public.community_members for delete to authenticated using (user_id = (select auth.uid()));

create policy "Follow relationships are visible"
  on public.follows for select to authenticated using (true);
create policy "Users follow other profiles"
  on public.follows for insert to authenticated with check (follower_id = (select auth.uid()));
create policy "Users unfollow profiles"
  on public.follows for delete to authenticated using (follower_id = (select auth.uid()));

create policy "Posts are public"
  on public.posts for select to anon, authenticated using (true);
create policy "Members publish posts"
  on public.posts for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (
      select 1 from public.community_members membership
      where membership.community_id = posts.community_id
        and membership.user_id = (select auth.uid())
    )
  );
create policy "Authors edit their posts"
  on public.posts for update to authenticated using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "Authors delete their posts"
  on public.posts for delete to authenticated using (author_id = (select auth.uid()));

create policy "Users can see their own likes"
  on public.post_likes for select to authenticated using (user_id = (select auth.uid()));
create policy "Users like posts"
  on public.post_likes for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users remove their likes"
  on public.post_likes for delete to authenticated using (user_id = (select auth.uid()));

create policy "Users see their own saved posts"
  on public.saved_posts for select to authenticated using (user_id = (select auth.uid()));
create policy "Users save posts"
  on public.saved_posts for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users unsave posts"
  on public.saved_posts for delete to authenticated using (user_id = (select auth.uid()));

create policy "Comments are public"
  on public.comments for select to anon, authenticated using (true);
create policy "Signed-in users comment"
  on public.comments for insert to authenticated with check (author_id = (select auth.uid()));
create policy "Authors delete their comments"
  on public.comments for delete to authenticated using (author_id = (select auth.uid()));

create view public.feed_posts as
select
  post.id,
  post.author_id,
  author.username,
  author.display_name,
  author.account_type,
  author.avatar_url,
  post.community_id,
  community.name as community_name,
  community.slug as community_slug,
  post.body,
  post.tags,
  post.media_path,
  post.created_at,
  (select count(*)::integer from public.post_likes likes where likes.post_id = post.id) as like_count,
  (select count(*)::integer from public.comments replies where replies.post_id = post.id) as comment_count
from public.posts post
join public.profiles author on author.id = post.author_id
join public.communities community on community.id = post.community_id;

create view public.community_directory as
select
  community.id,
  community.slug,
  community.name,
  community.description,
  community.created_by,
  community.created_at,
  (select count(*)::integer from public.community_members members where members.community_id = community.id) as member_count,
  (select count(*)::integer from public.posts posts where posts.community_id = community.id) as post_count
from public.communities community;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  display_name_value text;
  username_base text;
begin
  display_name_value := left(
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'New maker'),
    50
  );
  username_base := trim(both '_' from regexp_replace(lower(display_name_value), '[^a-z0-9]+', '_', 'g'));
  username_base := left(coalesce(nullif(username_base, ''), 'maker'), 23);

  insert into public.profiles (id, username, display_name, account_type)
  values (
    new.id,
    username_base || '_' || left(replace(new.id::text, '-', ''), 8),
    display_name_value,
    case when new.raw_user_meta_data ->> 'account_type' = 'brand' then 'brand' else 'person' end
  );

  insert into public.community_members (community_id, user_id)
  select id, new.id from public.communities
  on conflict do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke all on function public.handle_new_user() from public, anon, authenticated;

insert into public.communities (slug, name, description)
values
  ('design-friends', 'Design friends', 'A friendly place for sketches, process, and thoughtful design.'),
  ('slow-living', 'Slow living', 'Small rituals, quieter days, and the good things made with care.'),
  ('indie-makers', 'Indie makers', 'Independent people and small brands sharing what they make.'),
  ('good-things-cooking', 'Good things cooking', 'Recipes, experiments, and the joy of feeding people.')
on conflict (slug) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('noad-media', 'noad-media', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Post images are publicly readable"
  on storage.objects for select to anon, authenticated using (bucket_id = 'noad-media');
create policy "Users upload images to their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'noad-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy "Users delete images from their own folder"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'noad-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.communities, public.posts, public.comments to anon, authenticated;
grant select, insert, update, delete on public.community_members, public.follows, public.post_likes, public.saved_posts to authenticated;
grant insert, update, delete on public.profiles to authenticated;
grant insert, update, delete on public.communities, public.posts, public.comments to authenticated;
grant select on public.feed_posts, public.community_directory to anon, authenticated;
