const get = id => document.getElementById(id);
const frame = get('player-frame');
const loader = get('player-loading');

const card = get('player-card');
const focusButton = get('focus-toggle');
function applyOrientation(width = 0, height = 0, drm = false) {
  const portrait = !(width > 0 && height > 0 && width > height);
  card?.classList.toggle('is-portrait', portrait);
  frame.classList.toggle('is-portrait', portrait);
  const quality = get('quality-label');
  if (quality) {
    quality.textContent = drm ? 'DRM player · Portrait' :
      (width > 0 && height > 0 ? width + ' × ' + height + ' · Original MP4' : 'Portrait · Original MP4');
  }
}
function setFocus(active) {
  document.body.classList.toggle('viewer-focus', Boolean(active));
  if (focusButton) {
    focusButton.setAttribute('aria-pressed', String(Boolean(active)));
    focusButton.textContent = active ? '⤡ Exit focus' : '⤢ Focus view';
    focusButton.setAttribute('aria-label', active ? 'Exit expanded inline video player' : 'Expand the inline video player');
  }
}
focusButton?.addEventListener('click', () => setFocus(!document.body.classList.contains('viewer-focus')));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('viewer-focus')) setFocus(false);
});

function showError(message) {
  loader.replaceChildren();
  const box = document.createElement('div'); box.className = 'video-message';
  const title = document.createElement('strong'); title.textContent = 'Playback unavailable';
  const text = document.createElement('span'); text.textContent = message;
  box.append(title, text); loader.append(box);
}
function moveWatermarks(customer) {
  const marks = [get('watermark-a'), get('watermark-b')];
  const dateTime = () => new Date().toLocaleString('en-BD', { hour12:false });
  const update = () => {
    marks[0].textContent = `${customer.id} • ${customer.name}`;
    marks[1].textContent = `${customer.id} • ${dateTime()}`;
    marks.forEach((mark, i) => {
      mark.style.left = `${5 + Math.random()*32 + i*15}%`;
      mark.style.top = `${10 + Math.random()*60}%`;
      mark.style.right = 'auto'; mark.style.bottom = 'auto';
    });
  };
  update(); setInterval(update, 5700);
}
function displayCountdown(expiry) {
  const end = Number(expiry);
  const el = get('expires-label');
  const update = () => {
    const left = end - Date.now();
    if (left <= 0) {
      el.textContent = 'Access expired';
      setFocus(false);
      const video = frame.querySelector('video'); if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      const iframe = frame.querySelector('iframe'); if (iframe) iframe.remove();
      showError('Your access time has ended. Contact the tutorial owner for a new link.');
      loader.hidden = false;
      return;
    }
    const hours = Math.floor(left / 3600000);
    const minutes = Math.floor(left % 3600000 / 60000);
    el.textContent = `Access ends in ${hours}h ${String(minutes).padStart(2, '0')}m`;
  };
  update(); setInterval(update, 15000);
}
async function start() {
  try {
    const r = await fetch('/api/watch/session', { cache:'no-store' });
    if (!r.ok) throw new Error('This session has expired. Ask the owner for a new link.');
    const viewer = await r.json();
    get('watch-id').textContent = viewer.id;
    applyOrientation();
    moveWatermarks(viewer);
    displayCountdown(viewer.expiresAt);
    if (!viewer.ready) throw new Error('The tutorial owner has not uploaded or configured the video yet.');
    if (viewer.mode === 'vdocipher') {
      get('mode-label').textContent = 'DRM streaming · Watermarked viewing';
      applyOrientation(0, 0, true);
      const credential = await fetch('/api/vdo/playback', { method:'POST', credentials:'same-origin', cache:'no-store' });
      const details = await credential.json();
      if (!credential.ok) throw new Error(details.error || 'Unable to authorize the DRM player.');
      const iframe = document.createElement('iframe');
      iframe.src = details.iframeUrl;
      iframe.allow = 'encrypted-media; fullscreen';
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = 'no-referrer';
      iframe.title = 'Protected tutorial video';
      frame.prepend(iframe);
    } else {
      get('mode-label').textContent = 'Private streaming · No native download button · No DRM';
      const video = document.createElement('video');
      video.controls = true; video.playsInline = true; video.preload = 'metadata';
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.addEventListener('loadedmetadata', () => applyOrientation(video.videoWidth, video.videoHeight));
      video.addEventListener('resize', () => applyOrientation(video.videoWidth, video.videoHeight));
      video.disablePictureInPicture = true;
      video.setAttribute('controlsList', 'nodownload noremoteplayback');
      video.setAttribute('disableRemotePlayback', '');
      video.src = '/api/media/stream';
      video.addEventListener('contextmenu', e => e.preventDefault());
      video.addEventListener('error', () => {
        showError('This MP4 could not play on your device. For iPhone Safari, H.264 video with AAC audio is recommended. The site does not change video quality.'); loader.hidden = false;
      });
      document.addEventListener('visibilitychange', () => { if (document.hidden && !video.paused) video.pause(); });
      frame.prepend(video);
    }
    loader.hidden = true;
  } catch (e) { showError(e.message); }
}
start();
