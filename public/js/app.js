'use strict';
/* Scrapbook World Cruise — front-end
   Depende de: bootstrap (global), i18n.js (translations, t, locale, currentLang). */

// ─── Utilitários ──────────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Cria elementos sem innerHTML: todo texto entra como textContent (à prova de XSS). */
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(c => { if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(c)); });
  return node;
}
const icon = name => el('i', { class: `bi bi-${name}`, 'aria-hidden': 'true' });

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

async function api(url, options = {}) {
  const res = await fetch(url, options);
  let data = null;
  try { data = await res.json(); } catch { /* corpo vazio */ }
  return { ok: res.ok, status: res.status, data };
}
const jsonBody = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Carregamento sob demanda de bibliotecas pesadas (Leaflet, flatpickr, heic2any, exifr, QR)
const _loading = {};
function loadScript(src) {
  return (_loading[src] ||= new Promise((resolve, reject) => {
    const s = el('script', { src });
    s.onload = resolve;
    s.onerror = () => { delete _loading[src]; reject(new Error(`Falha ao carregar ${src}`)); };
    document.head.append(s);
  }));
}
function loadCss(href) {
  return (_loading[href] ||= new Promise(resolve => {
    const l = el('link', { rel: 'stylesheet', href });
    l.onload = resolve; l.onerror = resolve;
    document.head.append(l);
  }));
}

function formatDate(value) {
  if (!value) return t('gallery.dateUnavailable');
  const d = new Date(value);
  if (isNaN(d)) return t('gallery.dateUnavailable');
  return d.toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatDateTime(value) {
  const d = new Date(value);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Toasts e confirmação (substituem alert/confirm) ─────────────────────────
function toast(message, type = 'success') {
  const node = el('div', { class: `toast align-items-center border-0 is-${type}`, role: type === 'error' ? 'alert' : 'status', 'aria-atomic': 'true' },
    el('div', { class: 'd-flex' },
      el('div', { class: 'toast-body' }, icon(type === 'error' ? 'exclamation-triangle-fill' : 'check-circle-fill'), el('span', { text: message })),
      el('button', { type: 'button', class: 'btn-close me-2 m-auto', 'data-bs-dismiss': 'toast', 'aria-label': t('lightbox.close') })));
  $('#toast-container').append(node);
  node.addEventListener('hidden.bs.toast', () => node.remove());
  bootstrap.Toast.getOrCreateInstance(node, { delay: type === 'error' ? 5000 : 3500 }).show();
}

function confirmDialog(message, okLabel = t('gallery.deleteBtn')) {
  return new Promise(resolve => {
    const modalEl = $('#confirmModal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    $('#confirm-message').textContent = message;
    $('#confirm-ok').textContent = okLabel;
    let answer = false;
    const ok = () => { answer = true; modal.hide(); };
    const cancel = () => modal.hide();
    const done = () => {
      $('#confirm-ok').removeEventListener('click', ok);
      $('#confirm-cancel').removeEventListener('click', cancel);
      resolve(answer);
    };
    $('#confirm-ok').addEventListener('click', ok);
    $('#confirm-cancel').addEventListener('click', cancel);
    modalEl.addEventListener('hidden.bs.modal', done, { once: true });
    modal.show();
  });
}

// ─── Tema (claro/escuro) ──────────────────────────────────────────────────────
function setTheme(mode) {
  document.documentElement.setAttribute('data-bs-theme', mode);
  try { localStorage.setItem('theme', mode); } catch { /* modo privado */ }
}
$('#theme-toggle').addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark');
});

// ─── Estado ───────────────────────────────────────────────────────────────────
let currentUser = null;
let imagesCache = [];
let commentCounts = {};          // { [imageKey]: n }
let currentLocationFilter = 'all';
let currentSort = 'comments';
let viewList = [];               // imagens visíveis (filtradas + ordenadas)

const isAdmin = () => currentUser?.role === 'admin';
const roleLabel = role => t({ admin: 'comment.roleAdmin', viewer: 'comment.roleViewer', commenter: 'comment.roleCommenter' }[role] || 'comment.roleAnonymous');

// ─── i18n ─────────────────────────────────────────────────────────────────────
function applyLanguage(lang) {
  const dict = translations[lang] || translations.pt;
  $$('[data-i18n]').forEach(n => { if (dict[n.dataset.i18n] !== undefined) n.textContent = dict[n.dataset.i18n]; });
  $$('[data-i18n-placeholder]').forEach(n => { if (dict[n.dataset.i18nPlaceholder] !== undefined) n.placeholder = dict[n.dataset.i18nPlaceholder]; });
  $$('[data-i18n-aria]').forEach(n => n.setAttribute('aria-label', t(n.dataset.i18nAria)));
  $('#lang-code').textContent = lang.toUpperCase();
  $$('[data-lang]').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
  document.documentElement.lang = lang;
  setHeroMoreLabel();
  updateStatsLabel();
  if (currentUser) { $('#current-role').textContent = roleLabel(currentUser.role); }
  if (imagesCache.length) { renderLocationFilter(); renderGallery({ animate: false }); }
  if (lb.isOpen) renderLightbox({ keepImage: true });
}
function setLanguage(lang) {
  currentLang = lang;
  try { localStorage.setItem('lang', lang); } catch { /* ignore */ }
  applyLanguage(lang);
}
$$('[data-lang]').forEach(b => b.addEventListener('click', () => setLanguage(b.dataset.lang)));

// ─── Navbar / Hero ────────────────────────────────────────────────────────────
const nav = $('#app-nav');
const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

function setHeroMoreLabel() {
  const open = $('#hero-more').classList.contains('open');
  $('#hero-more-btn span').textContent = t(open ? 'hero.less' : 'hero.more');
  $('#hero-more-btn span').dataset.i18n = open ? 'hero.less' : 'hero.more';
}
$('#hero-more-btn').addEventListener('click', () => {
  const box = $('#hero-more');
  const open = box.classList.toggle('open');
  $('#hero-more-btn').setAttribute('aria-expanded', String(open));
  setHeroMoreLabel();
});
// Se a imagem do hero não carregar (offline/bloqueada), esconde a moldura em vez de mostrar ícone quebrado
const heroImg = $('.hero-figure img');
const hideHeroFigure = () => { $('.hero-figure').hidden = true; };
heroImg.addEventListener('error', hideHeroFigure);
if (heroImg.complete && heroImg.naturalWidth === 0) hideHeroFigure();
$('#brand-link').addEventListener('click', e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

// ─── Auth ─────────────────────────────────────────────────────────────────────
const loginModal = bootstrap.Modal.getOrCreateInstance($('#loginModal'));
function openLogin() { $('#auth-error').textContent = ''; loginModal.show(); }
$('#loginModal').addEventListener('shown.bs.modal', () => $('#login-form input[name="username"]').focus());
$('#login-btn').addEventListener('click', openLogin);
$('#strip-login-btn').addEventListener('click', openLogin);

async function refreshAuth() {
  const { data } = await api('/auth-status');
  currentUser = data?.user || null;
  renderAuth();
  await loadImages();
}

function renderAuth() {
  const user = currentUser;
  $('#login-btn').hidden = !!user;
  $('#user-menu').hidden = !user;
  $('#strip-guest').hidden = !!user;
  $('#strip-user').hidden = !user;
  $('#stat-row').hidden = !user;
  $('#new-image-btn').hidden = !isAdmin();
  if (!isAdmin()) $('#admin-actions').hidden = true;

  if (user) {
    $('#auth-dropdown-label').textContent = user.username;
    $('#user-avatar').textContent = user.username.charAt(0).toUpperCase();
    $('#current-user').textContent = user.username;
    $('#current-role').textContent = roleLabel(user.role);
    document.body.dataset.role = user.role;
    loadStats();
  } else {
    delete document.body.dataset.role;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.target;
  const btn = $('button[type="submit"]', form);
  const errorEl = $('#auth-error');
  const formData = new FormData(form); // captura antes de desabilitar os campos
  btn.disabled = true;
  btn.replaceChildren(el('span', { class: 'spinner-border spinner-border-sm me-2', role: 'status' }), t('login.btnLoading'));
  $$('input', form).forEach(i => (i.disabled = true));
  errorEl.textContent = '';
  try {
    const { ok, data } = await api('/login', jsonBody('POST', { username: formData.get('username'), password: formData.get('password') }));
    if (!ok) { errorEl.textContent = data?.error || t('login.errorMsg'); return; }
    currentUser = data.user;
    form.reset();
    loginModal.hide();
    renderAuth();
    loadImages();
  } catch {
    errorEl.textContent = t('login.errorMsg');
  } finally {
    btn.disabled = false;
    btn.textContent = t('login.btn');
    $$('input', form).forEach(i => (i.disabled = false));
  }
}

async function handleLogout() {
  await fetch('/logout', { method: 'POST' });
  currentUser = null;
  renderAuth();
  await loadImages();
}
$('#login-form').addEventListener('submit', handleLogin);
$('#logout-btn').addEventListener('click', handleLogout);

// ─── Stats ────────────────────────────────────────────────────────────────────
const statValues = { images: 0, comments: 0 };
function updateStatsLabel() {
  const label = $('#stats-images-label');
  const key = isAdmin() ? 'stats.images' : 'stats.members';
  label.dataset.i18n = key;
  label.textContent = t(key);
}
function animateNumber(node, from, to) {
  if (prefersReducedMotion() || from === to) { node.textContent = to; return; }
  const start = performance.now(), dur = 700;
  const tick = now => {
    const p = Math.min((now - start) / dur, 1);
    node.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
async function loadStats() {
  try {
    const { ok, data } = await api('/stats');
    if (!ok) return;
    updateStatsLabel();
    const images = data.images ?? 0, comments = data.comments ?? 0;
    animateNumber($('#stats-images'), statValues.images, images);
    animateNumber($('#stats-comments'), statValues.comments, comments);
    statValues.images = images; statValues.comments = comments;
  } catch (e) { console.warn('Stats error:', e); }
}

// ─── Galeria ──────────────────────────────────────────────────────────────────
function showSkeleton(n = 6) {
  const grid = $('#gallery');
  grid.replaceChildren(...Array.from({ length: n }, () => el('div', { class: 'skeleton', 'aria-hidden': 'true' })));
  $('#empty-gallery').hidden = true;
}

async function loadImages() {
  try {
    const [imagesRes, countsRes] = await Promise.all([
      api('/images'),
      currentUser ? api('/comments/counts') : Promise.resolve(null),
    ]);
    if (!imagesRes.ok || !Array.isArray(imagesRes.data)) throw new Error('images');
    commentCounts = countsRes?.ok ? countsRes.data : {};
    imagesCache = imagesRes.data;
    renderLocationFilter();
    renderGallery();
  } catch {
    $('#gallery').replaceChildren();
    $('#empty-gallery').hidden = false;
    $('#empty-gallery p').textContent = t('gallery.loadError');
    $('#empty-gallery p').dataset.i18n = 'gallery.loadError';
  }
}

function getVisibleImages() {
  const time = i => new Date(i.photoDate || i.uploadDate || 0).getTime();
  let list = [...imagesCache];
  if (currentSort === 'newest') list.sort((a, b) => time(b) - time(a));
  else if (currentSort === 'oldest') list.sort((a, b) => time(a) - time(b));
  else list.sort((a, b) => (commentCounts[b.key] || 0) - (commentCounts[a.key] || 0));
  if (currentLocationFilter !== 'all') list = list.filter(i => i.location === currentLocationFilter);
  return list;
}

function renderLocationFilter() {
  const wrap = $('#location-filter-buttons');
  const locations = [...new Set(imagesCache.map(i => i.location).filter(Boolean))];
  wrap.replaceChildren();
  if (currentLocationFilter !== 'all' && !locations.includes(currentLocationFilter)) currentLocationFilter = 'all';
  wrap.hidden = locations.length === 0;
  if (!locations.length) return;
  [['all', t('gallery.filterAll')], ...locations.map(l => [l, l])].forEach(([value, label]) => {
    const active = currentLocationFilter === value;
    wrap.append(el('button', {
      type: 'button', class: `chip${active ? ' active' : ''}`, 'aria-pressed': String(active), text: label,
      onclick: () => { currentLocationFilter = value; renderLocationFilter(); renderGallery(); },
    }));
  });
}

function buildCard(img, index, rankPos) {
  const count = commentCounts[img.key] || 0;
  const place = img.location || t('gallery.noLocation');
  const date = formatDate(img.photoDate || img.uploadDate);

  const top = el('div', { class: 'photo-top' });
  if (img.private) top.append(el('span', { class: 'pill-glass' }, icon('lock-fill'), t('upload.privateBadge')));
  if (count > 0) {
    const cls = ['rank-1st', 'rank-2nd', 'rank-3rd'][rankPos] || '';
    const label = count === 1 ? `1 ${t('comment.singular')}` : `${count} ${t('comment.plural')}`;
    top.append(el('span', { class: `rank-badge ${cls}` }, rankPos > -1 && rankPos < 3 ? icon('trophy-fill') : icon('chat-dots-fill'), label));
  }

  const image = el('img', { src: img.thumbUrl || img.url, alt: '', loading: 'lazy', decoding: 'async' });
  // se a miniatura ainda não existir (fotos antigas), cai para a imagem original
  image.addEventListener('error', () => { if (image.src !== img.url) image.src = img.url; }, { once: true });

  return el('button', {
    type: 'button', class: 'photo-card', style: `--i:${Math.min(index, 12)}`,
    'aria-label': `${place} — ${date}`,
    onclick: () => openLightbox(index),
  },
    image, top,
    el('div', { class: 'photo-meta' },
      el('span', { class: 'photo-date', text: date }),
      el('div', { class: 'photo-place' }, icon('geo-alt-fill'), el('span', { text: place })),
      img.summary ? el('p', { class: 'photo-summary', text: img.summary }) : null));
}

function renderGallery({ animate = true } = {}) {
  const grid = $('#gallery');
  const empty = $('#empty-gallery');
  viewList = getVisibleImages();

  const countPill = $('#gallery-count');
  countPill.hidden = imagesCache.length === 0;
  countPill.textContent = imagesCache.length === 1 ? t('gallery.photoCountOne') : t('gallery.photoCount', { n: imagesCache.length });

  grid.replaceChildren();
  grid.classList.toggle('no-anim', !animate);
  empty.hidden = viewList.length > 0;
  if (!viewList.length) {
    $('p', empty).textContent = t('gallery.empty');
    $('p', empty).dataset.i18n = 'gallery.empty';
    return;
  }

  const ranking = imagesCache.filter(i => (commentCounts[i.key] || 0) > 0)
    .sort((a, b) => commentCounts[b.key] - commentCounts[a.key]).map(i => i.key);

  const frag = document.createDocumentFragment();
  viewList.forEach((img, i) => frag.append(buildCard(img, i, ranking.indexOf(img.key))));
  grid.append(frag);
}

$('#sort-select').addEventListener('change', e => { currentSort = e.target.value; renderGallery(); });

// ─── Lightbox ─────────────────────────────────────────────────────────────────
const lb = {
  root: $('#lightbox'), img: $('#lb-img'), stage: $('#lb-stage'),
  list: [], index: 0, isOpen: false, lastFocus: null, token: 0, pushed: false,
};
const lbImage = () => lb.list[lb.index];

function openLightbox(index) {
  lb.list = [...viewList];
  lb.index = index;
  lb.isOpen = true;
  lb.lastFocus = document.activeElement;
  lb.root.classList.add('open');
  document.body.classList.add('lb-lock');
  renderLightbox();
  $('#lb-close').focus();
  history.pushState({ lb: 1 }, '');
  lb.pushed = true;
}

function closeLightbox({ fromPop = false } = {}) {
  if (!lb.isOpen) return;
  lb.isOpen = false;
  lb.token++;
  lb.root.classList.remove('open');
  document.body.classList.remove('lb-lock');
  lb.img.removeAttribute('src');
  if (lb.pushed && !fromPop) history.back();
  lb.pushed = false;
  lb.lastFocus?.focus?.();
}
window.addEventListener('popstate', () => { if (lb.isOpen) { lb.pushed = false; closeLightbox({ fromPop: true }); } });

function stepLightbox(delta) {
  if (lb.list.length < 2) return;
  lb.index = (lb.index + delta + lb.list.length) % lb.list.length;
  renderLightbox();
}

function renderLightbox({ keepImage = false } = {}) {
  const img = lbImage();
  if (!img) return;
  const place = img.location || t('gallery.noLocation');

  // Foto: mostra a miniatura (já em cache) e troca pela original quando carregar
  if (!keepImage) {
    lb.img.classList.remove('swap'); void lb.img.offsetWidth; lb.img.classList.add('swap');
    lb.img.src = img.thumbUrl || img.url;
    if (img.thumbUrl) {
      const full = new Image();
      full.onload = () => { if (lbImage() === img && lb.isOpen) lb.img.src = img.url; };
      full.src = img.url;
    }
    // pré-carrega vizinhas
    [1, -1].forEach(d => { const n = lb.list[(lb.index + d + lb.list.length) % lb.list.length]; if (n && n !== img) new Image().src = n.thumbUrl || n.url; });
  }
  lb.img.alt = img.summary || place;
  $('#lb-counter').textContent = `${lb.index + 1} / ${lb.list.length}`;
  $('#lb-prev').hidden = $('#lb-next').hidden = lb.list.length < 2;
  $('#lb-counter').hidden = lb.list.length < 2;

  $('#lb-date').textContent = formatDate(img.photoDate || img.uploadDate);
  $('#lb-place').textContent = place;
  $('#lb-summary').textContent = img.summary || t('gallery.noDescription');

  const tags = $('#lb-tags');
  tags.replaceChildren();
  if (img.private) tags.append(el('span', { class: 'tag is-private' }, icon('lock-fill'), t('upload.privateBadge')));
  if (img.uploadedBy) tags.append(el('span', { class: 'tag' }, icon('person-fill'), `${t('gallery.uploadedBy')} ${img.uploadedBy}`));
  if (img.gps?.lat != null && img.gps?.lng != null) {
    tags.append(el('button', { type: 'button', class: 'tag', onclick: () => openMapModal(img.gps.lat, img.gps.lng, img.location) },
      icon('geo-alt-fill'), `${t('gallery.viewMap')}`, icon('arrow-up-right')));
  }

  const admin = $('#lb-admin');
  admin.hidden = !isAdmin();
  admin.replaceChildren();
  if (isAdmin()) {
    admin.append(
      el('button', { type: 'button', class: 'btn btn-outline-secondary btn-sm px-3', onclick: () => openEditModal(img) }, icon('pencil'), ' ', t('gallery.editBtn')),
      el('button', { type: 'button', class: 'btn btn-outline-danger btn-sm px-3', onclick: () => deleteImage(img) }, icon('trash3'), ' ', t('gallery.deleteBtn')));
  }

  renderComments(img);
}

async function deleteImage(img) {
  if (!(await confirmDialog(t('gallery.deleteConfirm')))) return;
  const { ok } = await api(`/images?key=${encodeURIComponent(img.key)}`, { method: 'DELETE' });
  if (!ok) { toast(t('gallery.deleteError'), 'error'); return; }
  closeLightbox();
  await loadImages();
  loadStats();
}

$('#lb-close').addEventListener('click', () => closeLightbox());
$('#lb-prev').addEventListener('click', () => stepLightbox(-1));
$('#lb-next').addEventListener('click', () => stepLightbox(1));
lb.stage.addEventListener('click', e => { if (e.target === lb.stage) closeLightbox(); });

let touchX = null;
lb.stage.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
lb.stage.addEventListener('touchend', e => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
});

document.addEventListener('keydown', e => {
  if (!lb.isOpen || $('.modal.show')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') { closeLightbox(); }
  else if (e.key === 'ArrowLeft' && !typing) { stepLightbox(-1); }
  else if (e.key === 'ArrowRight' && !typing) { stepLightbox(1); }
  else if (e.key === 'Tab') { // mantém o foco dentro do lightbox
    const f = $$('button:not([hidden]), textarea, input, select, a[href]', lb.root).filter(n => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// ─── Comentários (dentro do lightbox) ─────────────────────────────────────────
function updateCommentCount(imageKey, delta) {
  commentCounts[imageKey] = Math.max(0, (commentCounts[imageKey] || 0) + delta);
  renderGallery({ animate: false });
  loadStats();
}

function renderComments(img) {
  const list = $('#lb-comments-list');
  const compose = $('#lb-compose');
  compose.replaceChildren();

  if (!currentUser) {
    list.replaceChildren();
    compose.hidden = true;
    list.append(el('div', { class: 'lb-login' },
      icon('chat-heart'),
      el('span', { text: t('comment.loginPrompt') }),
      el('button', { type: 'button', class: 'btn btn-primary btn-sm px-4', onclick: () => openLogin(), text: t('login.btn') })));
    $('#lb-comments-title').textContent = t('comment.toggle');
    return;
  }
  compose.hidden = false;
  compose.append(buildComposer(img));
  loadComments(img);
}

async function loadComments(img) {
  const list = $('#lb-comments-list');
  const token = ++lb.token;
  list.replaceChildren(el('small', { class: 'text-secondary', text: t('comment.loading') }));
  try {
    const { ok, data } = await api(`/comments?imageKey=${encodeURIComponent(img.key)}`);
    if (token !== lb.token) return; // usuário já mudou de foto
    if (!ok || !Array.isArray(data)) throw new Error('comments');

    const n = data.length;
    $('#lb-comments-title').textContent = n === 0 ? t('comment.toggle') : `${n} ${n === 1 ? t('comment.singular') : t('comment.plural')}`;
    if (n === 0) { list.replaceChildren(el('small', { class: 'text-secondary', text: t('comment.none') })); return; }
    list.replaceChildren(...data.map(c => buildComment(c, img)));
    list.scrollTop = list.scrollHeight;
  } catch {
    if (token === lb.token) list.replaceChildren(el('small', { class: 'text-danger', text: t('comment.error') }));
  }
}

function buildComment(c, img) {
  const name = c.authorName || '?';
  const role = ['admin', 'viewer', 'commenter'].includes(c.authorRole) ? c.authorRole : 'anonymous';
  const textEl = el('div', { class: 'comment-text', text: c.text });
  const actions = el('div', { class: 'comment-actions' });
  const body = el('div', { class: 'comment-body' },
    el('div', { class: 'comment-head' },
      el('span', { class: 'comment-author', text: name }),
      el('span', { class: `role-badge role-${role}`, text: roleLabel(role) })),
    c.authorEmail ? el('div', { class: 'comment-email', text: c.authorEmail }) : null,
    textEl,
    el('div', { class: 'comment-time', text: formatDateTime(c.createdAt) }),
    actions);

  if (isAdmin()) {
    actions.append(
      el('button', { type: 'button', class: 'link-btn', text: t('comment.edit'), onclick: () => startEditComment(c, img, textEl, actions) }),
      el('button', { type: 'button', class: 'link-btn danger', text: t('comment.delete'), onclick: async () => {
        if (!(await confirmDialog(t('comment.deleteConfirm')))) return;
        const { ok } = await api(`/comments/${c._id}`, { method: 'DELETE' });
        if (!ok) { toast(t('comment.deleteError'), 'error'); return; }
        updateCommentCount(img.key, -1);
        loadComments(img);
      } }));
  }
  return el('div', { class: 'comment' }, el('div', { class: 'avatar', 'aria-hidden': 'true', text: name.charAt(0).toUpperCase() }), body);
}

function startEditComment(c, img, textEl, actions) {
  if (textEl.nextElementSibling?.classList.contains('comment-edit')) return;
  const area = el('textarea', { class: 'form-control form-control-sm', rows: '3', maxlength: '1000' });
  area.value = c.text;
  const restore = () => { editBox.remove(); textEl.hidden = false; actions.hidden = false; };
  const editBox = el('div', { class: 'comment-edit mt-2 d-flex flex-column gap-2' }, area,
    el('div', { class: 'd-flex gap-2' },
      el('button', { type: 'button', class: 'btn btn-primary btn-sm px-3', text: t('comment.editSave'), onclick: async () => {
        const text = area.value.trim();
        if (!text) return;
        const { ok } = await api(`/comments/${c._id}`, jsonBody('PATCH', { text }));
        if (ok) loadComments(img);
        else { toast(t('comment.editError'), 'error'); restore(); }
      } }),
      el('button', { type: 'button', class: 'btn btn-outline-secondary btn-sm px-3', text: t('comment.editCancel'), onclick: restore })));
  textEl.hidden = true; actions.hidden = true;
  textEl.after(editBox);
  area.focus();
}

function buildComposer(img) {
  const role = currentUser?.role;
  const needsName = role === 'commenter' || role === 'viewer';
  const needsEmail = role === 'commenter';
  const store = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };

  const nameInput = needsName ? el('input', { type: 'text', class: 'form-control form-control-sm', maxlength: '80', placeholder: t('comment.namePlaceholder'), autocomplete: 'name' }) : null;
  const emailInput = needsName ? el('input', { type: 'email', class: 'form-control form-control-sm', maxlength: '120', placeholder: t('comment.emailPlaceholder'), autocomplete: 'email' }) : null;
  if (nameInput) { nameInput.value = store('commentName'); emailInput.value = store('commentEmail'); }

  const textarea = el('textarea', { class: 'form-control', rows: '2', maxlength: '1000', placeholder: t('comment.placeholder'), 'aria-label': t('comment.placeholder') });
  const send = el('button', { type: 'button', class: 'btn btn-primary btn-icon flex-none', 'aria-label': t('comment.btn') }, icon('send-fill'));

  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    const body = { imageKey: img.key, text };
    if (needsName) {
      const name = nameInput.value.trim(), email = emailInput.value.trim();
      if (!name || (needsEmail && !email)) { toast(t('comment.anonAlert'), 'error'); return; }
      body.name = name;
      if (email) body.email = email;
    }
    send.disabled = true;
    try {
      const { ok, data } = await api('/comments', jsonBody('POST', body));
      if (!ok) { toast(data?.error || t('comment.sendError'), 'error'); return; }
      if (needsName) { try { localStorage.setItem('commentName', body.name); localStorage.setItem('commentEmail', body.email || ''); } catch { /* ignore */ } }
      textarea.value = '';
      updateCommentCount(img.key, +1);
      loadComments(img);
    } finally { send.disabled = false; }
  };
  send.addEventListener('click', submit);
  textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });

  return el('div', {},
    needsName ? el('div', { class: 'compose-fields' }, nameInput, emailInput) : null,
    el('div', { class: 'compose-row' }, textarea, send));
}

// ─── Editar imagem (admin) ────────────────────────────────────────────────────
const editModal = bootstrap.Modal.getOrCreateInstance($('#editModal'));
function openEditModal(img) {
  $('#edit-key').value = img.key;
  $('#edit-location').value = img.location || '';
  $('#edit-summary').value = img.summary || '';
  $('#edit-private').checked = !!img.private;
  const d = img.photoDate ? new Date(img.photoDate) : null;
  $('#edit-date').value = d && !isNaN(d) ? d.toISOString().slice(0, 10) : '';
  editModal.show();
}
$('#edit-save-btn').addEventListener('click', async () => {
  const key = $('#edit-key').value;
  const { ok } = await api('/images', jsonBody('PATCH', {
    key, location: $('#edit-location').value, summary: $('#edit-summary').value,
    photoDate: $('#edit-date').value, private: $('#edit-private').checked,
  }));
  if (!ok) { toast(t('edit.saveError'), 'error'); return; }
  editModal.hide();
  await loadImages();
  const idx = viewList.findIndex(i => i.key === key);
  if (lb.isOpen) {
    lb.list = [...viewList];
    lb.index = idx > -1 ? idx : 0;
    if (!lb.list.length) closeLightbox(); else renderLightbox({ keepImage: true });
  }
});

// ─── Mapa (Leaflet sob demanda) ───────────────────────────────────────────────
const mapModalEl = $('#mapModal');
const mapModal = bootstrap.Modal.getOrCreateInstance(mapModalEl);
let leafletMap = null;

async function openMapModal(lat, lng, location) {
  lat = parseFloat(lat); lng = parseFloat(lng);
  if (!isFinite(lat) || !isFinite(lng)) return;
  $('#map-coords-label').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  $('#map-location-label').textContent = location || '';
  $('#map-open-link').href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=15`;

  await Promise.all([loadCss('/vendor/leaflet/leaflet.css'), loadScript('/vendor/leaflet/leaflet.js')]);
  mapModalEl.addEventListener('shown.bs.modal', () => {
    leafletMap?.remove();
    leafletMap = L.map('map-leaflet').setView([lat, lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>', maxZoom: 19,
    }).addTo(leafletMap);
    const marker = L.marker([lat, lng]).addTo(leafletMap);
    if (location) marker.bindPopup(el('b', { text: location })).openPopup();
  }, { once: true });
  mapModal.show();
}
mapModalEl.addEventListener('hidden.bs.modal', () => { leafletMap?.remove(); leafletMap = null; });

// ─── QR Code (admin) ──────────────────────────────────────────────────────────
async function showQrModal() {
  try {
    const { ok, data } = await api('/qr-key');
    if (!ok || !data?.key) { toast(t('qr.keyMissing'), 'error'); return; }
    const url = `${window.location.origin}/login-qr?key=${encodeURIComponent(data.key)}`;
    await loadScript('/vendor/qrcodejs/qrcode.min.js');
    $('#qr-url-input').value = url;
    const canvas = $('#qr-canvas');
    canvas.replaceChildren();
    new QRCode(canvas, { text: url, width: 220, height: 220, colorDark: '#0b1b33', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
    bootstrap.Modal.getOrCreateInstance($('#qrModal')).show();
  } catch (e) {
    toast(`${t('qr.fetchError')}: ${e.message}`, 'error');
  }
}
$('#qr-btn').addEventListener('click', showQrModal);
$('#qr-copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText($('#qr-url-input').value).then(() => {
    const btn = $('#qr-copy-btn');
    btn.textContent = t('qr.copied');
    setTimeout(() => { btn.textContent = t('qr.copy'); }, 2000);
  });
});

// ─── Upload (admin) ───────────────────────────────────────────────────────────
const uploadArea = $('#upload-area');
const fileInput = $('#file-input');
let datePicker = null;

async function openUploadArea() {
  if (!currentUser) { openLogin(); return; }
  const panel = $('#admin-actions');
  panel.hidden = false;
  panel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (!datePicker) {
    try {
      await Promise.all([loadCss('/vendor/flatpickr/flatpickr.min.css'), loadScript('/vendor/flatpickr/flatpickr.min.js')]);
      datePicker = flatpickr($('#photoDate'), { dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y', allowInput: true, disableMobile: true });
    } catch { /* o campo continua utilizável como texto */ }
  }
}
$('#new-image-btn').addEventListener('click', openUploadArea);
$('#upload-close').addEventListener('click', () => { $('#admin-actions').hidden = true; });

uploadArea.addEventListener('click', e => { if (!e.target.closest('#remove-image')) fileInput.click(); });
uploadArea.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', showPreview);
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault(); uploadArea.classList.remove('dragover');
  if (e.dataTransfer.files[0]) { fileInput.files = e.dataTransfer.files; showPreview(); }
});

const isHeicFile = f => f.type === 'image/heic' || f.type === 'image/heif' || /\.hei[cf]$/i.test(f.name);

function showPreview() {
  const file = fileInput.files[0];
  if (!file) return;
  if (isHeicFile(file)) { // o navegador não exibe HEIC: mostra só o nome
    $('#preview-image').removeAttribute('src');
  } else {
    const reader = new FileReader();
    reader.onload = e => { $('#preview-image').src = e.target.result; };
    reader.readAsDataURL(file);
  }
  $('#upload-preview').hidden = false;
  $('#upload-placeholder').hidden = true;
}
function resetUploadArea() {
  fileInput.value = '';
  $('#preview-image').removeAttribute('src');
  $('#upload-preview').hidden = true;
  $('#upload-placeholder').hidden = false;
  uploadArea.classList.remove('dragover');
}
$('#remove-image').addEventListener('click', e => { e.stopPropagation(); resetUploadArea(); });

async function extractGps(file) {
  try {
    await loadScript('/vendor/exifr/full.umd.js');
    const r = await exifr.gps(file);
    if (r?.latitude != null && r?.longitude != null) return { lat: +r.latitude.toFixed(6), lng: +r.longitude.toFixed(6) };
  } catch (e) { console.warn('Erro ao extrair GPS:', e); }
  return null;
}
async function convertHeicIfNeeded(file) {
  if (!isHeicFile(file)) return file;
  await loadScript('/vendor/heic2any/heic2any.min.js');
  const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const out = Array.isArray(blob) ? blob[0] : blob;
  return new File([out], file.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' });
}

async function handleUpload(event) {
  event.preventDefault();
  const form = event.target;
  const original = fileInput.files[0];
  if (!original) return;
  const overlay = $('#upload-overlay');
  overlay.classList.add('active');
  try {
    // HEIC: extrai GPS antes de converter (a conversão remove os metadados)
    const heicGps = isHeicFile(original) ? await extractGps(original) : null;
    let file;
    try { file = await convertHeicIfNeeded(original); }
    catch { toast(t('upload.errorHeic'), 'error'); return; }

    const fd = new FormData();
    fd.append('photo', file);
    fd.append('summary', form.summary.value || '');
    fd.append('location', form.location.value || '');
    fd.append('photoDate', form.photoDate.value || '');
    fd.append('private', form.private.checked ? 'true' : 'false');
    if (heicGps) { fd.append('gpsLat', heicGps.lat); fd.append('gpsLng', heicGps.lng); }

    const { ok, data } = await api('/upload', { method: 'POST', body: fd });
    if (!ok) { toast(data?.error || t('upload.errorMsg'), 'error'); return; }
    form.reset();
    datePicker?.clear();
    toast(t('upload.successToast'));
    await loadImages();
    loadStats();
  } catch {
    toast(t('upload.errorMsg'), 'error');
  } finally {
    overlay.classList.remove('active');
    resetUploadArea();
  }
}
$('#upload-form').addEventListener('submit', handleUpload);

// ─── PWA ──────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
}

// ─── Init ─────────────────────────────────────────────────────────────────────
showSkeleton();
applyLanguage(currentLang);
refreshAuth();
