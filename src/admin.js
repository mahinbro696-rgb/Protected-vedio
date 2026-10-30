const byId = id => document.getElementById(id);
const show = (el, visible) => { if (el) el.hidden = !visible; };

async function api(path, opts = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...opts });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const postJson = (path, data) => api(path, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });
const msg = (text, error = false) => {
  const el = byId('admin-message');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('critical', error);
};
function displayDate(ms) { return new Date(ms).toLocaleString('en-BD', { dateStyle:'medium', timeStyle:'short' }); }
function button(label, css, callback) {
  const el = document.createElement('button');
  el.type = 'button'; el.className = `mini-btn ${css}`; el.textContent = label;
  el.addEventListener('click', callback);
  return el;
}
function cell(row, text, second = '') {
  const td = document.createElement('td');
  const primary = document.createElement('strong'); primary.textContent = text;
  td.append(primary);
  if (second) { const secondary = document.createElement('small'); secondary.textContent = second; td.append(secondary); }
  row.append(td); return td;
}
function revealLink(url) {
  const box = byId('link-result');
  byId('generated-link').value = url;
  show(box, true);
  box.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

async function loadDashboard() {
  try {
    const data = await api('/api/admin/overview');
    const customers = data.customers;
    byId('stat-total').textContent = customers.length;
    byId('stat-active').textContent = customers.filter(c => c.active && c.status !== 'expired').length;
    byId('stat-activated').textContent = customers.filter(c => c.status === 'activated').length;
    byId('stat-blocked').textContent = customers.filter(c => c.status === 'expired' || c.status === 'revoked').length;
    byId('video-mode').textContent = data.mode === 'vdocipher' ? 'DRM mode' : 'Private MP4';
    const status = byId('video-state');
    if (data.mode === 'vdocipher') {
      status.textContent = data.configured ? '✓ VdoCipher credentials configured. Videos will play through DRM-authorized sessions.' : 'VdoCipher mode selected, but video ID or API secret is missing from your server environment.';
      byId('video-upload-wrap').hidden = true;
    } else {
      status.textContent = data.configured ? `✓ Video ready · ${Math.round(data.size / (1024*1024) * 10)/10} MB · Private Vercel Blob storage` : 'No MP4 uploaded. Upload your one tutorial video to enable customer playback.';
      byId('video-upload-wrap').hidden = false;
    }
    const tbody = byId('customers'); tbody.replaceChildren();
    if (!customers.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td'); td.colSpan = 4; td.className = 'empty-row';
      td.textContent = 'No customers yet. Create the first secure access link above.';
      tr.append(td); tbody.append(tr); return;
    }
    for (const c of customers) {
      const tr = document.createElement('tr');
      cell(tr, c.name, c.id);
      cell(tr, displayDate(c.expiresAt));
      const statusCell = document.createElement('td');
      const statusSpan = document.createElement('span');
      statusSpan.className = `status-${c.status}`;
      const dot = document.createElement('span'); dot.className = 'status-dot';
      statusSpan.append(dot, document.createTextNode(c.status.charAt(0).toUpperCase() + c.status.slice(1)));
      statusCell.append(statusSpan); tr.append(statusCell);
      const actions = document.createElement('td');
      actions.append(button('Reissue link', '', async () => {
        if (!confirm(`Create a new 24-hour link for ${c.name}? This will log out the previous viewer.`)) return;
        try {
          const result = await postJson(`/api/admin/customers/${c.id}/reissue`, { hours:24 });
          revealLink(result.link); msg('New link generated. Previous device access is now invalid.');
          await loadDashboard();
        } catch (e) { msg(e.message, true); }
      }));
      if (c.active && c.status !== 'expired') {
        actions.append(button('Revoke', 'danger', async () => {
          if (!confirm(`Revoke all access for ${c.name}?`)) return;
          try {
            await postJson(`/api/admin/customers/${c.id}/revoke`, {});
            msg('Access revoked. Any active video stream must reauthorize on its next request.');
            await loadDashboard();
          } catch (e) { msg(e.message, true); }
        }));
      }
      tr.append(actions); tbody.append(tr);
    }
  } catch (e) { msg(e.message, true); }
}

function initLogin() {
  const form = byId('admin-login'); if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    const error = byId('login-error');
    submit.disabled = true; error.hidden = true;
    try {
      const data = new FormData(form);
      await postJson('/api/admin/login', { username:String(data.get('username') || ''), password:String(data.get('password') || '') });
      location.assign('/admin');
    } catch (e) { error.textContent = e.message; error.hidden = false; }
    finally { submit.disabled = false; }
  });
}

function initDashboard() {
  const create = byId('create-customer'); if (!create) return;
  create.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = create.querySelector('button[type=submit]'); submit.disabled = true;
    try {
      const form = new FormData(create);
      const result = await postJson('/api/admin/customers', { name:String(form.get('name') || ''), hours:Number(form.get('hours')) });
      revealLink(result.link); msg('Customer invitation created. Copy the new link before leaving.');
      create.reset(); await loadDashboard();
    } catch (e) { msg(e.message, true); }
    finally { submit.disabled = false; }
  });
  byId('refresh').addEventListener('click', loadDashboard);
  byId('logout').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method:'POST' }); location.assign('/admin'); }
    catch (e) { msg(e.message, true); }
  });
  byId('copy-link').addEventListener('click', async () => {
    const input = byId('generated-link');
    try { await navigator.clipboard.writeText(input.value); msg('Link copied to clipboard.'); }
    catch { input.select(); msg('Select and copy the highlighted link.'); }
  });
  const file = byId('video-file');
  const upload = byId('upload-btn');
  const progress = byId('upload-progress');
  const drop = byId('drop-zone');

  const preview = byId('upload-preview');
  const previewFrame = byId('upload-preview-frame');
  const previewBox = byId('upload-video-details');
  const previewTitle = byId('upload-video-title');
  const previewSpecs = byId('upload-video-specs');
  let localPreviewUrl = '';
  const clearPreview = () => {
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    localPreviewUrl = '';
  };
  preview.addEventListener('loadedmetadata', () => {
    const selected = file.files?.[0];
    if (!selected) return;
    const width = preview.videoWidth, height = preview.videoHeight;
    if (!(width > 0 && height > 0)) return;
    const portrait = height >= width;
    previewFrame.classList.toggle('is-portrait', portrait);
    previewSpecs.textContent = width + ' × ' + height + ' pixels · ' +
      (portrait ? 'Portrait' : 'Landscape') + ' · ' +
      (selected.size / (1024 * 1024)).toFixed(1) + ' MB';
  });
  preview.addEventListener('error', () => {
    if (file.files?.[0]) {
      previewSpecs.textContent = 'Preview unavailable in this browser. For iPhone playback, use H.264/AAC MP4.';
    }
  });
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    clearPreview();
    show(previewBox, Boolean(selected));
    if (!selected) { upload.disabled = true; progress.textContent = ''; return; }
    const mp4 = selected.type === 'video/mp4' || selected.name.toLowerCase().endsWith('.mp4');
    const maxSize = 500 * 1024 * 1024;
    upload.disabled = !mp4 || selected.size > maxSize || selected.size < 128;
    previewTitle.textContent = selected.name;
    previewSpecs.textContent = (selected.size / (1024 * 1024)).toFixed(1) +
      ' MB · Reading original resolution…';
    progress.textContent = !mp4 ? 'Choose an MP4 video (H.264/AAC recommended).' :
      selected.size > maxSize ? 'Video is above the 500 MB upload limit.' :
      selected.size < 128 ? 'Selected file is empty or invalid.' :
      'Ready — original MP4 will be uploaded without compression.';
    if (mp4 && selected.size >= 128) {
      localPreviewUrl = URL.createObjectURL(selected);
      preview.src = localPreviewUrl;
      preview.load();
    }
  });
  window.addEventListener('pagehide', clearPreview);
  for (const e of ['dragenter','dragover']) drop.addEventListener(e, ev => { ev.preventDefault(); drop.style.borderColor = '#84f0c5'; });
  for (const e of ['dragleave','drop']) drop.addEventListener(e, ev => { ev.preventDefault(); drop.style.borderColor = ''; });
  drop.addEventListener('drop', ev => {
    if (ev.dataTransfer?.files?.length) {
      file.files = ev.dataTransfer.files;
      file.dispatchEvent(new Event('change'));
    }
  });
  // Big source videos must use multipart upload. Single-request uploads often hang at 0%
  // for files above ~100-200 MB, especially over slower mobile networks.
  const cancelUpload = byId('upload-cancel-btn');
  const progressTrack = byId('progress-track');
  let currentUpload = null;
  cancelUpload?.addEventListener('click', () => {
    if (!currentUpload) return;
    progress.textContent = 'Cancelling upload...';
    cancelUpload.disabled = true;
    currentUpload.abort();
  });

  function sendPrivateChunk(ticket, index, chunk, controller, onProgress) {
    return new Promise((resolve,reject) => {
      const xhr=new XMLHttpRequest();
      xhr.open('PUT','/api/admin/video/segment-chunk');
      xhr.withCredentials=true;
      xhr.timeout=120000;
      xhr.setRequestHeader('Content-Type','application/octet-stream');
      xhr.setRequestHeader('X-Upload-Ticket',ticket);
      xhr.setRequestHeader('X-Part-Index',String(index));
      const abort=()=>xhr.abort();
      controller.signal.addEventListener('abort',abort,{once:true});
      const cleanup=()=>controller.signal.removeEventListener('abort',abort);
      xhr.upload.addEventListener('progress',event=>{
        if(event.lengthComputable)onProgress(Math.min(chunk.size,event.loaded));
      });
      xhr.onload=()=>{
        cleanup();
        let reply={};
        try{reply=JSON.parse(xhr.responseText)}catch{}
        if(xhr.status===200&&reply.ok)resolve(reply);
        else reject(new Error(reply.error || 'Upload chunk '+(index+1)+' failed with HTTP '+xhr.status));
      };
      xhr.onerror=()=>{cleanup();reject(new Error('Connection to video server failed for chunk '+(index+1)));};
      xhr.ontimeout=()=>{cleanup();reject(new Error('Chunk '+(index+1)+' timed out. Check your connection.'));};
      xhr.onabort=()=>{cleanup();reject(new DOMException('Upload cancelled','AbortError'));};
      if(controller.signal.aborted){cleanup();return reject(new DOMException('Upload cancelled','AbortError'));}
      xhr.send(chunk);
    });
  }

  upload.addEventListener('click', async () => {
    const selected=file.files?.[0];
    if(!selected || currentUpload)return;
    if(selected.type!=='video/mp4' && !selected.name.toLowerCase().endsWith('.mp4'))
      return msg('Please select an MP4 file.',true);
    if(selected.size>500*1024*1024 || selected.size<128)
      return msg('Select an MP4 between 128 bytes and 500 MB.',true);
    const controller=new AbortController();
    currentUpload=controller;
    file.disabled=true;
    upload.disabled=true;
    show(cancelUpload,true);
    cancelUpload.disabled=false;
    show(progressTrack,true);
    const bar=byId('progress-fill');
    const startedAt=Date.now();
    let completed=0;
    let nextIndex=0;
    let chunksDone=0;
    let lastActivity=Date.now();
    const active=new Map();
    const drawProgress=()=>{
      const sent=completed + Array.from(active.values()).reduce((sum,n)=>sum+n,0);
      const percent=Math.min(100,Math.floor(sent/selected.size*100));
      bar.style.width=percent+'%';
      progressTrack.setAttribute('aria-valuenow',String(percent));
      const mb=(sent/1048576).toFixed(1);
      progress.textContent='Uploading directly to secure website… '+percent+'% ('+
        mb+' / '+(selected.size/1048576).toFixed(1)+' MB), '+chunksDone+' chunks stored';
    };
    bar.style.width='0%';
    progressTrack.setAttribute('aria-valuenow','0');
    progress.textContent='Checking authenticated upload service…';
    msg('Your original MP4 is being transferred in 3 MB secure chunks. No recompression.');
    const stalled=setInterval(()=>{
      if(!controller.signal.aborted && Date.now()-lastActivity>20000){
        const waiting=Math.round((Date.now()-lastActivity)/1000);
        progress.textContent='Waiting for upload server ('+waiting+'s). You can cancel and retry.';
      }
    },5000);
    try {
      const init=await api('/api/admin/video/segment-init',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({size:selected.size}),
        signal:controller.signal,
      });
      if(typeof init.ticket!=='string'||!Number.isInteger(init.partBytes)||!Number.isInteger(init.partCount))
        throw new Error('Video upload server did not return a valid secure session.');
      if(init.partBytes>3.5*1024*1024 || init.partCount!==Math.ceil(selected.size/init.partBytes))
        throw new Error('Invalid chunk configuration returned by server.');
      progress.textContent='Secure session ready — sending video chunks…';
      const uploadOne=async index=>{
        const from=index*init.partBytes;
        const piece=selected.slice(from,Math.min(selected.size,from+init.partBytes),'application/octet-stream');
        for(let attempt=1;attempt<=3;attempt++){
          if(controller.signal.aborted)throw new DOMException('Upload cancelled','AbortError');
          try {
            active.set(index,0);
            const reply=await sendPrivateChunk(init.ticket,index,piece,controller,loaded=>{
              active.set(index,loaded);
              lastActivity=Date.now();
              drawProgress();
            });
            if(reply.bytes!==piece.size)throw new Error('Chunk '+(index+1)+' byte count mismatch');
            active.delete(index);
            completed+=piece.size;
            chunksDone++;
            lastActivity=Date.now();
            drawProgress();
            return;
          }catch(error){
            active.delete(index);
            if(controller.signal.aborted)throw error;
            if(attempt>=3)throw new Error('Chunk '+(index+1)+' failed after three tries: '+error.message);
            progress.textContent='Retrying chunk '+(index+1)+' (attempt '+(attempt+1)+'/3): '+error.message;
            await new Promise(resolve=>setTimeout(resolve,attempt*1300));
          }
        }
      };
      const worker=async()=>{
        while(nextIndex<init.partCount){
          const index=nextIndex++;
          await uploadOne(index);
        }
      };
      // Two concurrent same-origin requests: avoid Blob CORS/token-handshake stalls.
      try {
        await Promise.all([worker(),worker()]);
      } catch(error) {
        controller.abort();
        throw error;
      }
      if(controller.signal.aborted)throw new DOMException('Upload cancelled','AbortError');
      progress.textContent='All chunks received. Checking video integrity…';
      const completeResult=await postJson('/api/admin/video/segment-finish',{ticket:init.ticket});
      if(!completeResult.ok || completeResult.size!==selected.size)
        throw new Error('Final file size verification failed.');
      bar.style.width='100%';
      progressTrack.setAttribute('aria-valuenow','100');
      progress.textContent='Upload complete — '+(selected.size/1048576).toFixed(1)+' MB, original quality';
      msg('Video saved successfully. Full source resolution and bytes preserved.');
      file.value='';
      file.dispatchEvent(new Event('change'));
      await loadDashboard();
    }catch(error){
      const cancelled=error?.name==='AbortError' || (controller.signal.aborted && !error?.message?.includes('failed after'));
      msg(cancelled ? 'Upload cancelled. No new video was published.' :
        'Upload failed: '+(error?.message||'Unknown error'),!cancelled);
      progress.textContent=cancelled?'Upload cancelled. Click Upload protected video to retry.':
        'Error: '+(error?.message||'Upload failed. Please retry.');
    }finally{
      clearInterval(stalled);
      currentUpload=null;
      file.disabled=false;
      cancelUpload.disabled=false;
      show(cancelUpload,false);
      upload.disabled=!file.files?.[0];
    }
  });
  loadDashboard();
}
initLogin(); initDashboard();
