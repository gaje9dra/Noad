const PAGE_SIZE = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPABASE_JS_VERSION = "2.118.0";
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const postList = document.querySelector("#post-list");
const loadMoreButton = document.querySelector("#load-more");
const composeDialog = document.querySelector("#compose-dialog");
const composeForm = document.querySelector("#compose-form");
const postText = document.querySelector("#post-text");
const postImage = document.querySelector("#post-image");
const imagePreview = document.querySelector("#image-preview");
const charCount = document.querySelector("#char-count");
const authDialog = document.querySelector("#auth-dialog");
const authForm = document.querySelector("#auth-form");
const communityDialog = document.querySelector("#community-dialog");
const communityForm = document.querySelector("#community-form");
const commentsDialog = document.querySelector("#comments-dialog");
const commentsList = document.querySelector("#comments-list");
const commentForm = document.querySelector("#comment-form");
const searchInput = document.querySelector("#search-input");
const toast = document.querySelector("#toast");
const currentDate = new Date();
const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

document.querySelector("#current-date").textContent = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric"
}).format(currentDate).toUpperCase();
document.querySelector("#current-year").textContent = String(currentDate.getFullYear());

const state = {
  supabase: null,
  user: null,
  profile: null,
  communities: [],
  memberships: new Set(),
  follows: new Set(),
  likes: new Set(),
  saved: new Set(),
  posts: [],
  activeFeed: "For you",
  activeView: "For you",
  activeSort: "Popular",
  activeSearch: "",
  communityId: null,
  nextCursor: null,
  hasMore: false,
  selectedCommentPost: null,
  selectedImageUrl: null,
  authMode: "signup",
  toastTimeout: null,
  loadingPosts: false,
  feedRequestId: 0
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(state.toastTimeout);
  state.toastTimeout = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function setLoading(message) {
  postList.innerHTML = `<div class="empty-state" role="status"><strong>${escapeHtml(message)}</strong>Please wait a moment.</div>`;
  loadMoreButton.hidden = true;
}

function setEmpty(title, detail) {
  postList.innerHTML = `<div class="empty-state"><strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}</div>`;
  loadMoreButton.hidden = true;
}

function ensureConfigured() {
  const config = window.NOAD_SUPABASE_CONFIG;
  const url = typeof config?.url === "string" ? config.url.trim() : "";
  const anonKey = typeof config?.anonKey === "string" ? config.anonKey.trim() : "";
  let validUrl = false;
  try {
    const parsedUrl = new URL(url);
    validUrl = parsedUrl.protocol === "https:" || ["localhost", "127.0.0.1"].includes(parsedUrl.hostname);
  } catch {
    validUrl = false;
  }
  if (!validUrl || !anonKey || anonKey.toLowerCase().includes("replace")) {
    setEmpty(
      "Connect your Supabase project to launch noad.",
      "Add your project URL and publishable/anon key to supabase-config.js, then apply the database migration in supabase/migrations."
    );
    showToast("Supabase setup is required before the live feed can load.");
    return null;
  }
  return { url, anonKey };
}

function getErrorMessage(error) {
  if (error?.code === "23505") return "That action already exists.";
  if (error?.code === "23503") return "That item is no longer available. Refresh and try again.";
  if (error?.status === 401 || error?.status === 403) return "Please sign in again to continue.";
  return error?.message || "Something went wrong. Please try again.";
}

function requireSuccess(result) {
  if (result.error) throw result.error;
  return result.data;
}

function showFailure(error, context) {
  console.error(context, error);
  showToast(getErrorMessage(error));
}

function initials(name) {
  return String(name || "?").trim().slice(0, 1).toUpperCase();
}

function avatarMarkup(profile, extraClass = "") {
  const name = profile?.display_name || profile?.username || "Maker";
  if (profile?.avatar_url) {
    return `<img class="avatar ${extraClass}" src="${escapeHtml(profile.avatar_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  return `<span class="avatar ${extraClass}">${escapeHtml(initials(name))}</span>`;
}

function relativeDate(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return relativeTime.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return relativeTime.format(days, "day");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

function imageUrl(path) {
  if (!path || !state.supabase) return "";
  const { data } = state.supabase.storage.from("noad-media").getPublicUrl(path);
  return data.publicUrl;
}

function postCard(post) {
  const liked = state.likes.has(post.id);
  const saved = state.saved.has(post.id);
  const authorName = post.display_name || post.username;
  const tags = Array.isArray(post.tags)
    ? post.tags.map((tag) => `#${escapeHtml(tag)}`).join("  ")
    : "";
  const media = post.media_path
    ? `<img class="post-image" src="${escapeHtml(imageUrl(post.media_path))}" alt="Photo shared by ${escapeHtml(authorName)}" loading="lazy" decoding="async">`
    : "";
  const brandLabel = post.account_type === "brand" ? '<span class="brand-badge">MAKER BRAND</span>' : "";

  return `<article class="post-card" data-post-id="${escapeHtml(post.id)}" data-author-id="${escapeHtml(post.author_id)}">
    <div class="post-topline">
      ${avatarMarkup({ display_name: authorName, avatar_url: post.avatar_url }, "post-avatar")}
      <div class="author-details">
        <div class="author-line"><strong>${escapeHtml(authorName)}</strong>${brandLabel}</div>
        <div class="post-subline">@${escapeHtml(post.username)} <span>·</span> <button class="post-community" type="button" data-community-id="${escapeHtml(post.community_id)}">${escapeHtml(post.community_name)}</button> <span>·</span> <time datetime="${escapeHtml(post.created_at)}">${escapeHtml(relativeDate(post.created_at))}</time></div>
      </div>
      <button class="post-more" type="button" aria-label="${post.author_id === state.user?.id ? "Delete your post" : "Post options"}" data-action="more">···</button>
    </div>
    <div class="post-copy">${post.body ? `<p>${escapeHtml(post.body).replace(/\n/g, "<br>")}</p>` : ""}${tags ? `<p class="post-tags">${tags}</p>` : ""}</div>
    ${media}
    <div class="post-actions">
      <button class="action-button like-button ${liked ? "is-active" : ""}" type="button" data-action="like" aria-pressed="${liked}" aria-label="${liked ? "Unlike" : "Like"} post"><span class="action-icon">${liked ? "♥" : "♡"}</span><span>${Number(post.like_count)}</span></button>
      <button class="action-button comment-button" type="button" data-action="comment" aria-label="View comments"><span class="action-icon">◯</span><span>${Number(post.comment_count) || 0}</span></button>
      <button class="action-button share-button" type="button" data-action="share" aria-label="Share post"><span class="action-icon">↗</span></button>
      <span class="action-spacer"></span>
      <button class="action-button bookmark-button ${saved ? "is-active" : ""}" type="button" data-action="save" aria-pressed="${saved}" aria-label="${saved ? "Remove from saved" : "Save post"}"><span class="action-icon">${saved ? "▣" : "▱"}</span></button>
    </div>
  </article>`;
}

function renderPosts() {
  let visible = [...state.posts];
  if (state.activeSearch) {
    const query = state.activeSearch.toLocaleLowerCase();
    visible = visible.filter((post) => [
      post.display_name, post.username, post.community_name, post.body,
      ...(Array.isArray(post.tags) ? post.tags : [])
    ].join(" ").toLocaleLowerCase().includes(query));
  }
  if (state.activeSort === "Popular" && state.activeFeed !== "Fresh") {
    visible.sort((a, b) => Number(b.like_count) - Number(a.like_count) || new Date(b.created_at) - new Date(a.created_at));
  } else {
    visible.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  if (!visible.length && !state.loadingPosts) {
    if (state.activeView === "Saved") {
      setEmpty("Nothing saved just yet.", "Save a post to keep it close.");
    } else if (state.activeFeed === "Following") {
      setEmpty("Your following feed is quiet.", state.user ? "Follow a maker to see their new work here." : "Sign in and follow makers to build your feed.");
    } else if (state.activeSearch) {
      setEmpty("No little sparks found.", "Try another search or be the first to share something.");
    } else {
      setEmpty("The community is just getting started.", "Join a community and share the first thing you are making.");
    }
    return;
  }
  postList.innerHTML = visible.map(postCard).join("");
  loadMoreButton.hidden = !state.hasMore || Boolean(state.activeSearch);
}

async function loadCommunities() {
  const result = await state.supabase
    .from("community_directory")
    .select("id,slug,name,description,member_count,post_count")
    .order("member_count", { ascending: false })
    .limit(50);
  state.communities = requireSuccess(result) || [];
  renderCommunitySections();
  renderComposeCommunities();
}

function communityIcon(index) {
  return ["✳", "☼", "⌘", "♨", "✿", "◌"][index % 6];
}

function renderCommunitySections() {
  const list = document.querySelector("#community-list");
  const discovery = document.querySelector("#community-discovery");
  const joined = state.communities.filter((community) => state.memberships.has(community.id));
  const leftItems = (joined.length ? joined : state.communities).slice(0, 6);
  list.innerHTML = leftItems.length ? leftItems.map((community) => {
    const index = state.communities.indexOf(community);
    return `<button type="button" class="community-link" data-community-id="${escapeHtml(community.id)}"><span class="community-dot dot-${index % 2 ? "peach" : "lilac"}">${communityIcon(index)}</span>${escapeHtml(community.name)}</button>`;
  }).join("") : '<p class="rail-loading">No communities yet.</p>';

  const popular = state.communities.slice(0, 4);
  discovery.innerHTML = popular.length ? popular.map((community, index) => {
    const joinedAlready = state.memberships.has(community.id);
    return `<div class="community-discovery-row">
      <span class="trend-rank">${String(index + 1).padStart(2, "0")}</span>
      <span class="community-discovery-copy"><strong>${escapeHtml(community.name)}</strong><small>${Number(community.member_count)} members · ${Number(community.post_count)} posts</small></span>
      <button class="community-join-button ${joinedAlready ? "joined" : ""}" type="button" data-join-community="${escapeHtml(community.id)}" aria-pressed="${joinedAlready}">${joinedAlready ? "Joined" : "Join"}</button>
    </div>`;
  }).join("") : '<p class="rail-loading">Create the first community.</p>';
}

function renderComposeCommunities() {
  const select = document.querySelector("#post-community");
  const available = state.communities.filter((community) => state.memberships.has(community.id));
  select.innerHTML = available.map((community) => `<option value="${escapeHtml(community.id)}">${escapeHtml(community.name)}</option>`).join("");
  select.disabled = !available.length;
}

async function loadSuggestions() {
  const container = document.querySelector("#people-suggestions");
  if (!state.user) {
    container.innerHTML = '<p class="rail-loading">Sign in to find and follow makers.</p>';
    return;
  }
  let query = state.supabase
    .from("profiles")
    .select("id,username,display_name,account_type,avatar_url")
    .neq("id", state.user.id)
    .limit(8);
  if (state.follows.size) query = query.not("id", "in", `(${[...state.follows].join(",")})`);
  const result = await query;
  const people = requireSuccess(result) || [];
  container.innerHTML = people.length ? people.slice(0, 4).map((person) => `<div class="person-row" data-profile-id="${escapeHtml(person.id)}">
    ${avatarMarkup(person)}
    <span class="person-copy"><strong>${escapeHtml(person.display_name)}</strong><small>${person.account_type === "brand" ? "Creative brand" : `@${escapeHtml(person.username)}`}</small></span>
    <button class="follow-button" type="button" data-follow-id="${escapeHtml(person.id)}" aria-pressed="false">Follow</button>
  </div>`).join("") : '<p class="rail-loading">You’re all caught up with makers.</p>';
}

async function loadRelations() {
  state.memberships.clear();
  state.follows.clear();
  state.likes.clear();
  state.saved.clear();
  if (!state.user) {
    renderCommunitySections();
    await loadSuggestions();
    return;
  }
  const [membersResult, followsResult] = await Promise.all([
    state.supabase.from("community_members").select("community_id").eq("user_id", state.user.id),
    state.supabase.from("follows").select("following_id").eq("follower_id", state.user.id)
  ]);
  for (const membership of requireSuccess(membersResult) || []) state.memberships.add(membership.community_id);
  for (const follow of requireSuccess(followsResult) || []) state.follows.add(follow.following_id);
  renderCommunitySections();
  renderComposeCommunities();
  await loadSuggestions();
}

async function fetchFeedPage(reset = true) {
  if (!reset && state.loadingPosts) return;
  const requestId = reset ? ++state.feedRequestId : state.feedRequestId;
  const activeView = state.activeView;
  const activeFeed = state.activeFeed;
  const communityId = state.communityId;
  const userId = state.user?.id;
  const followIds = [...state.follows];
  if (reset) {
    state.posts = [];
    state.nextCursor = null;
    state.hasMore = false;
    state.likes.clear();
    state.saved.clear();
    setLoading("Finding your people and their latest work…");
  }
  state.loadingPosts = true;
  loadMoreButton.disabled = true;
  loadMoreButton.textContent = "Loading…";
  try {
    let postIds = null;
    if (activeView === "Saved") {
      if (!userId) {
        state.posts = [];
        state.hasMore = false;
        return renderPosts();
      }
      const savedResult = await state.supabase.from("saved_posts")
        .select("post_id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (requestId !== state.feedRequestId) return;
      postIds = (requireSuccess(savedResult) || []).map((row) => row.post_id);
      state.saved = new Set(postIds);
      if (!postIds.length) {
        state.posts = [];
        state.hasMore = false;
        return renderPosts();
      }
    } else if (activeFeed === "Following") {
      if (!userId || !followIds.length) {
        state.posts = [];
        state.hasMore = false;
        return renderPosts();
      }
    }

    let query = state.supabase.from("feed_posts")
      .select("id,author_id,username,display_name,account_type,avatar_url,community_id,community_name,community_slug,body,tags,media_path,created_at,like_count,comment_count")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE + 1);
    if (communityId) query = query.eq("community_id", communityId);
    if (activeFeed === "Following") query = query.in("author_id", followIds);
    if (postIds) query = query.in("id", postIds);
    if (!reset && state.nextCursor) query = query.lt("created_at", state.nextCursor);
    const result = await query;
    if (requestId !== state.feedRequestId) return;
    const page = requireSuccess(result) || [];
    state.hasMore = page.length > PAGE_SIZE;
    const nextPage = page.slice(0, PAGE_SIZE);
    if (nextPage.length) state.nextCursor = nextPage[nextPage.length - 1].created_at;
    const ids = nextPage.map((post) => post.id);

    if (userId && ids.length) {
      const [likesResult, savedResult] = await Promise.all([
        state.supabase.from("post_likes").select("post_id").eq("user_id", userId).in("post_id", ids),
        state.supabase.from("saved_posts").select("post_id").eq("user_id", userId).in("post_id", ids)
      ]);
      if (requestId !== state.feedRequestId) return;
      for (const row of requireSuccess(likesResult) || []) state.likes.add(row.post_id);
      for (const row of requireSuccess(savedResult) || []) state.saved.add(row.post_id);
    }
    state.posts = reset ? nextPage : [...state.posts, ...nextPage];
    renderPosts();
  } catch (error) {
    if (requestId !== state.feedRequestId) return;
    state.loadingPosts = false;
    showFailure(error, "Unable to load the live community feed.");
    setEmpty("We couldn’t load the live feed.", "Check your connection and Supabase setup, then try again.");
    return;
  } finally {
    if (requestId === state.feedRequestId) {
      state.loadingPosts = false;
      loadMoreButton.disabled = false;
      loadMoreButton.textContent = "Load more";
    }
  }
}

async function refreshProfile() {
  if (!state.user) {
    state.profile = null;
    return;
  }
  const result = await state.supabase.from("profiles")
    .select("id,username,display_name,account_type,avatar_url")
    .eq("id", state.user.id)
    .maybeSingle();
  state.profile = requireSuccess(result);
  if (!state.profile) throw new Error("Your profile is still being set up. Refresh in a moment.");
}

function syncAccountControls() {
  const switcher = document.querySelector(".profile-switcher");
  const name = switcher.querySelector(".profile-copy strong");
  const handle = switcher.querySelector(".profile-copy small");
  const avatar = switcher.querySelector(".avatar");
  const signOut = document.querySelector(".settings-link");
  name.textContent = state.profile?.display_name || "Sign in to noad";
  handle.textContent = state.profile ? `@${state.profile.username}` : "Join the community";
  avatar.textContent = initials(state.profile?.display_name);
  signOut.hidden = !state.user;
}

async function refreshAll() {
  try {
    await Promise.all([refreshProfile(), loadCommunities()]);
    await loadRelations();
    renderComposeCommunities();
    syncAccountControls();
    await fetchFeedPage(true);
  } catch (error) {
    showFailure(error, "Unable to refresh noad.");
    setEmpty("We couldn’t connect to noad.", "Check your Supabase setup, network connection, and database migration.");
  }
}

function setActiveFeed(feed) {
  state.activeFeed = feed;
  state.activeView = feed;
  state.communityId = null;
  document.querySelectorAll(".feed-tab").forEach((tab) => {
    const selected = tab.dataset.feed === feed;
    tab.classList.toggle("selected", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === feed || (feed === "For you" && link.dataset.view === "For you"));
  });
  void fetchFeedPage(true);
}

function showAuth(mode = "signup") {
  state.authMode = mode;
  const signupFields = authForm.querySelectorAll(".signup-only");
  const isRecovery = mode === "recovery";
  const isSignup = mode === "signup";
  document.querySelector("#auth-title").textContent = isRecovery
    ? "Choose a new password."
    : state.user ? "You’re part of noad." : isSignup ? "Make yourself at home." : "Welcome back.";
  document.querySelector(".auth-dialog .dialog-subtitle").textContent = isRecovery
    ? "Choose a new password for your noad account."
    : state.user ? "Your account is ready. Sign out from here when you need to." : "Create an account to share work, find your people, and join communities.";
  document.querySelector("#auth-submit").textContent = isRecovery ? "Update password" : isSignup ? "Create account" : "Sign in";
  document.querySelector("#auth-switch-copy").hidden = !isSignup || Boolean(state.user);
  document.querySelector("#auth-switch").hidden = Boolean(state.user) || isRecovery;
  document.querySelector("#auth-reset").hidden = Boolean(state.user) || isSignup || isRecovery;
  document.querySelector("#auth-sign-out").hidden = !state.user;
  authForm.hidden = Boolean(state.user) && !isRecovery;
  for (const field of signupFields) {
    field.hidden = !isSignup;
    const control = field.matches("input,select");
    if (control) field.required = isSignup;
  }
  document.querySelector("#auth-password").autocomplete = isRecovery ? "new-password" : isSignup ? "new-password" : "current-password";
  if (!authDialog.open) authDialog.showModal();
}

function toggleAuthMode() {
  showAuth(state.authMode === "signup" ? "signin" : "signup");
}

function postTags(body) {
  return [...new Set([...body.matchAll(/#([a-z0-9_]{2,30})/gi)].map((match) => match[1].toLowerCase()))].slice(0, 10);
}

function slugify(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45);
}

async function joinCommunity(communityId) {
  if (!state.user) {
    showAuth("signup");
    return;
  }
  if (state.memberships.has(communityId)) {
    showToast("You’ve already joined this community.");
    return;
  }
  const result = await state.supabase.from("community_members").insert({
    community_id: communityId,
    user_id: state.user.id
  });
  requireSuccess(result);
  state.memberships.add(communityId);
  renderCommunitySections();
  renderComposeCommunities();
  showToast("You joined the community. Make yourself at home.");
}

async function changeFollow(profileId, button) {
  if (!state.user) return showAuth("signup");
  const following = state.follows.has(profileId);
  if (following) {
    const result = await state.supabase.from("follows")
      .delete().eq("follower_id", state.user.id).eq("following_id", profileId);
    requireSuccess(result);
    state.follows.delete(profileId);
  } else {
    const result = await state.supabase.from("follows").insert({
      follower_id: state.user.id,
      following_id: profileId
    });
    requireSuccess(result);
    state.follows.add(profileId);
  }
  button.textContent = following ? "Follow" : "Following";
  button.classList.toggle("following", !following);
  button.setAttribute("aria-pressed", String(!following));
  if (state.activeFeed === "Following") await fetchFeedPage(true);
  showToast(following ? "You unfollowed this maker." : "You’ll see more of their work.");
}

async function togglePostRelation(postId, action, button) {
  if (!state.user) {
    showAuth("signup");
    return;
  }
  const relation = action === "like" ? state.likes : state.saved;
  const table = action === "like" ? "post_likes" : "saved_posts";
  const isSet = relation.has(postId);
  if (isSet) {
    const result = await state.supabase.from(table)
      .delete().eq("post_id", postId).eq("user_id", state.user.id);
    requireSuccess(result);
    relation.delete(postId);
  } else {
    const result = await state.supabase.from(table).upsert(
      { post_id: postId, user_id: state.user.id },
      { onConflict: "post_id,user_id", ignoreDuplicates: true }
    );
    requireSuccess(result);
    relation.add(postId);
  }
  if (action === "like") {
    const post = state.posts.find((item) => item.id === postId);
    if (post) post.like_count = Math.max(0, Number(post.like_count) + (isSet ? -1 : 1));
  }
  renderPosts();
  if (action === "save") showToast(isSet ? "Removed from your saved posts." : "Saved for a little later.");
  if (button && !button.isConnected) return;
}

async function openComments(postId) {
  state.selectedCommentPost = postId;
  commentsList.innerHTML = '<p class="rail-loading">Loading the conversation…</p>';
  commentsDialog.showModal();
  commentForm.hidden = !state.user;
  try {
    const result = await state.supabase.from("comments")
      .select("id,body,created_at,author:profiles!comments_author_id_fkey(display_name,username)")
      .eq("post_id", postId)
      .order("created_at", { ascending: true })
      .limit(100);
    const comments = requireSuccess(result) || [];
    commentsList.innerHTML = comments.length ? comments.map((comment) => `<article class="comment-item">
      <div><strong>${escapeHtml(comment.author?.display_name || comment.author?.username || "Maker")}</strong><time>${escapeHtml(relativeDate(comment.created_at))}</time></div>
      <p>${escapeHtml(comment.body).replace(/\n/g, "<br>")}</p>
    </article>`).join("") : '<div class="empty-state"><strong>A little quiet so far.</strong>Start the conversation with something kind.</div>';
  } catch (error) {
    showFailure(error, "Unable to load comments.");
    commentsList.innerHTML = '<div class="empty-state"><strong>We couldn’t load comments.</strong>Please close and try again.</div>';
  }
}

async function deletePost(post) {
  if (post.author_id !== state.user?.id) {
    showToast("Use your community guidelines to keep this space welcoming.");
    return;
  }
  if (!window.confirm("Delete this post? This cannot be undone.")) return;
  const result = await state.supabase.from("posts").delete().eq("id", post.id);
  requireSuccess(result);
  if (post.media_path) {
    const cleanup = await state.supabase.storage.from("noad-media").remove([post.media_path]);
    if (cleanup.error) console.error("Could not remove post image after deleting the post.", cleanup.error);
  }
  state.posts = state.posts.filter((item) => item.id !== post.id);
  state.likes.delete(post.id);
  state.saved.delete(post.id);
  renderPosts();
  showToast("Your post was deleted.");
}

postList.addEventListener("click", async (event) => {
  const communityButton = event.target.closest("[data-community-id]");
  if (communityButton) {
    state.communityId = communityButton.dataset.communityId;
    state.activeView = "Communities";
    state.activeFeed = "For you";
    document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === "Communities"));
    document.querySelectorAll(".feed-tab").forEach((tab) => tab.classList.toggle("selected", tab.dataset.feed === "For you"));
    await fetchFeedPage(true);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const postId = button.closest("[data-post-id]")?.dataset.postId;
  if (!postId) return;
  try {
    if (button.dataset.action === "like" || button.dataset.action === "save") {
      await togglePostRelation(postId, button.dataset.action, button);
    } else if (button.dataset.action === "comment") {
      await openComments(postId);
    } else if (button.dataset.action === "share") {
      const url = new URL(window.location.href);
      url.hash = postId;
      await navigator.clipboard.writeText(url.href);
      showToast("Post link copied. Pass the good thing along.");
    } else if (button.dataset.action === "more") {
      const post = state.posts.find((item) => item.id === postId);
      if (post?.author_id === state.user?.id) await deletePost(post);
      else showToast("Be kind. Posts can be reported to moderators soon.");
    }
  } catch (error) {
    showFailure(error, `Unable to ${button.dataset.action} post.`);
  }
});

document.querySelectorAll(".feed-tab").forEach((tab) => {
  tab.addEventListener("click", () => setActiveFeed(tab.dataset.feed));
});

document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const view = link.dataset.view;
    state.communityId = null;
    if (view === "For you" || view === "Following") {
      setActiveFeed(view);
      return;
    }
    state.activeView = view;
    state.activeFeed = "For you";
    document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item === link));
    document.querySelectorAll(".feed-tab").forEach((tab) => tab.classList.toggle("selected", tab.dataset.feed === "For you"));
    if (view === "Saved" && !state.user) {
      state.posts = [];
      renderPosts();
      showAuth("signup");
      return;
    }
    void fetchFeedPage(true);
    if (view === "Explore") searchInput.focus();
  });
});

document.querySelector(".discover-link").addEventListener("click", () => {
  document.querySelector('.nav-link[data-view="Communities"]').click();
});

document.querySelector("#community-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-community-id]");
  if (!button) return;
  try {
    state.communityId = button.dataset.communityId;
    state.activeView = "Communities";
    state.activeFeed = "For you";
    document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === "Communities"));
    await fetchFeedPage(true);
  } catch (error) {
    showFailure(error, "Unable to open community.");
  }
});

document.querySelector("#community-discovery").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-join-community]");
  if (!button) return;
  try {
    await joinCommunity(button.dataset.joinCommunity);
  } catch (error) {
    showFailure(error, "Unable to join community.");
  }
});

document.querySelector("#people-suggestions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-follow-id]");
  if (!button) return;
  try {
    await changeFollow(button.dataset.followId, button);
  } catch (error) {
    showFailure(error, "Unable to update follow.");
  }
});

document.querySelector(".profile-switcher").addEventListener("click", () => showAuth(state.user ? "signin" : "signup"));
document.querySelector(".settings-link").addEventListener("click", async () => {
  try {
    const result = await state.supabase.auth.signOut();
    if (result.error) throw result.error;
    authDialog.close();
    showToast("You’ve signed out.");
  } catch (error) {
    showFailure(error, "Unable to sign out.");
  }
});
document.querySelector(".tiny-plus").addEventListener("click", () => {
  if (!state.user) return showAuth("signup");
  communityForm.reset();
  communityDialog.showModal();
});

document.querySelectorAll("[data-open-compose]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!state.user) return showAuth("signup");
    composeDialog.showModal();
    postText.focus();
  });
});

postText.addEventListener("input", () => {
  charCount.textContent = `${postText.value.length} / 500`;
});

postImage.addEventListener("change", () => {
  const file = postImage.files?.[0];
  if (state.selectedImageUrl) URL.revokeObjectURL(state.selectedImageUrl);
  state.selectedImageUrl = null;
  imagePreview.hidden = true;
  imagePreview.replaceChildren();
  if (!file) return;
  if (!ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES) {
    postImage.value = "";
    showToast("Choose a JPG, PNG, or WebP image smaller than 10 MB.");
    return;
  }
  state.selectedImageUrl = URL.createObjectURL(file);
  const preview = document.createElement("img");
  preview.src = state.selectedImageUrl;
  preview.alt = "Selected photo preview";
  imagePreview.append(preview);
  imagePreview.hidden = false;
});

composeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = postText.value.trim();
  const file = postImage.files?.[0] || null;
  const communityId = document.querySelector("#post-community").value;
  if (!state.user) {
    composeDialog.close();
    showAuth("signup");
    return;
  }
  if (!communityId) {
    showToast("Join a community before sharing your work.");
    return;
  }
  if (!body && !file) {
    postText.focus();
    return;
  }
  const submitButton = composeForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Sharing…";
  let uploadedPath = null;
  try {
    if (!state.memberships.has(communityId)) await joinCommunity(communityId);
    if (file) {
      if (!ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES) {
        throw new Error("Choose a JPG, PNG, or WebP image smaller than 10 MB.");
      }
      const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
      uploadedPath = `${state.user.id}/${crypto.randomUUID()}.${extension}`;
      const upload = await state.supabase.storage.from("noad-media").upload(uploadedPath, file, {
        cacheControl: "3600",
        contentType: file.type,
        upsert: false
      });
      if (upload.error) throw upload.error;
    }
    const insert = await state.supabase.from("posts").insert({
      author_id: state.user.id,
      community_id: communityId,
      body,
      tags: postTags(body),
      media_path: uploadedPath
    });
    if (insert.error) throw insert.error;
    composeForm.reset();
    charCount.textContent = "0 / 500";
    imagePreview.replaceChildren();
    imagePreview.hidden = true;
    if (state.selectedImageUrl) URL.revokeObjectURL(state.selectedImageUrl);
    state.selectedImageUrl = null;
    composeDialog.close();
    setActiveFeed("For you");
    showToast("Your creative work is out in the world.");
  } catch (error) {
    if (uploadedPath) {
      const cleanup = await state.supabase.storage.from("noad-media").remove([uploadedPath]);
      if (cleanup.error) console.error("Uploaded image cleanup failed after post creation failed.", cleanup.error);
    }
    showFailure(error, "Unable to publish post.");
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Share with the community <span>↗</span>';
  }
});

document.querySelector(".dismiss-note").addEventListener("click", () => {
  document.querySelector(".welcome-note").remove();
});

document.querySelector(".filter-button").addEventListener("click", () => {
  state.activeSort = state.activeSort === "Popular" ? "Recent" : "Popular";
  document.querySelector(".filter-label").textContent = state.activeSort;
  renderPosts();
});

loadMoreButton.addEventListener("click", () => void fetchFeedPage(false));

searchInput.addEventListener("input", () => {
  state.activeSearch = searchInput.value.trim();
  renderPosts();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.querySelector("#auth-email").value.trim();
  const password = document.querySelector("#auth-password").value;
  const submit = document.querySelector("#auth-submit");
  submit.disabled = true;
  try {
    if (state.authMode === "recovery") {
      const result = await state.supabase.auth.updateUser({ password });
      if (result.error) throw result.error;
      authDialog.close();
      showToast("Your password has been updated.");
      return;
    }
    if (state.authMode === "signup") {
      const displayName = document.querySelector("#auth-display-name").value.trim();
      const accountType = document.querySelector("#auth-account-type").value;
      const result = await state.supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName, account_type: accountType } }
      });
      if (result.error) throw result.error;
      authDialog.close();
      if (!result.data.session) showToast("Check your email to confirm your new account.");
      else showToast("Welcome to noad. Make yourself at home.");
    } else {
      const result = await state.supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      authDialog.close();
      showToast("Welcome back.");
    }
  } catch (error) {
    showFailure(error, "Authentication failed.");
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#auth-switch").addEventListener("click", toggleAuthMode);
document.querySelector("#auth-sign-out").addEventListener("click", async () => {
  try {
    const result = await state.supabase.auth.signOut();
    if (result.error) throw result.error;
    authDialog.close();
  } catch (error) {
    showFailure(error, "Unable to sign out.");
  }
});
document.querySelector("#auth-reset").addEventListener("click", async () => {
  const email = document.querySelector("#auth-email").value.trim();
  if (!email) {
    document.querySelector("#auth-email").focus();
    showToast("Enter your email first and we’ll send a reset link.");
    return;
  }
  try {
    const result = await state.supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if (result.error) throw result.error;
    showToast("Password reset instructions are on their way.");
  } catch (error) {
    showFailure(error, "Unable to request password reset.");
  }
});

communityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.user) return showAuth("signup");
  const name = document.querySelector("#community-name").value.trim();
  const description = document.querySelector("#community-description").value.trim();
  const baseSlug = slugify(name);
  if (!baseSlug) return showToast("Choose a community name with letters or numbers.");
  const button = communityForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const result = await state.supabase.from("communities").insert({
      name,
      description,
      slug: `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`,
      created_by: state.user.id
    }).select("id").single();
    const community = requireSuccess(result);
    const joinResult = await state.supabase.from("community_members").insert({
      community_id: community.id,
      user_id: state.user.id
    });
    requireSuccess(joinResult);
    state.memberships.add(community.id);
    await loadCommunities();
    communityDialog.close();
    showToast("Your community is ready. Invite people to join.");
  } catch (error) {
    showFailure(error, "Unable to create community.");
  } finally {
    button.disabled = false;
  }
});

commentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.user) return showAuth("signup");
  const body = document.querySelector("#comment-text").value.trim();
  if (!body || !state.selectedCommentPost) return;
  const button = commentForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const result = await state.supabase.from("comments").insert({
      post_id: state.selectedCommentPost,
      author_id: state.user.id,
      body
    });
    requireSuccess(result);
    document.querySelector("#comment-text").value = "";
    const post = state.posts.find((item) => item.id === state.selectedCommentPost);
    if (post) post.comment_count = Number(post.comment_count) + 1;
    await openComments(state.selectedCommentPost);
    renderPosts();
  } catch (error) {
    showFailure(error, "Unable to add comment.");
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.supabase) void fetchFeedPage(true);
});

async function start() {
  const config = ensureConfigured();
  if (!config) return;
  try {
    const { createClient } = await import(`https://esm.sh/@supabase/supabase-js@${SUPABASE_JS_VERSION}`);
    state.supabase = createClient(config.url, config.anonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true
      },
      global: { headers: { "x-application-name": "noad-web" } }
    });
    const authResult = await state.supabase.auth.getSession();
    if (authResult.error) throw authResult.error;
    state.user = authResult.data.session?.user || null;
    const { data } = state.supabase.auth.onAuthStateChange((event, session) => {
      state.user = session?.user || null;
      if (event === "PASSWORD_RECOVERY") showAuth("recovery");
      queueMicrotask(() => void refreshAll());
    });
    window.addEventListener("pagehide", () => data.subscription.unsubscribe(), { once: true });
    await refreshAll();
  } catch (error) {
    showFailure(error, "Unable to initialize the live Supabase app.");
    setEmpty("We couldn’t start noad.", "Verify your Supabase URL, publishable key, migration, and network connection.");
  }
}

void start();
