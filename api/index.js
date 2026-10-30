import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { put, head } from '@vercel/blob';
import {
  SEGMENT_BYTES,
  validVideoSize, makeUploadTicket, readUploadTicket,
  expectedSegmentBytes, partPath, parseVideoRange, videoSegmentSlices,
} from '../lib/segmented-video.js';
import {page,HOME,ADMIN_LOGIN,ADMIN_DASH,WATCH_PAGE,UNKNOWN,accessPage} from '../lib/ui.js';
import {
  uid,hash,now,passwordMatches,mintAdminCookie,checkAdminCookie,parseCookies,
  publicCustomer,validHours,CUSTOMER_ID,splitCustomerToken,
} from '../lib/security.js';
import {
  loadCustomer,saveCustomer,listCustomers,loadVideoSettings,saveVideoSettings,
} from '../lib/blob-store.js';

const ONE_HOUR = 3600000;
const MEDIA_CHUNK = 2 * 1024 * 1024;
const ADMIN_COOKIE = '__Host-vault-admin';
const VIEWER_COOKIE = '__Host-vault-viewer';
const attempts = new Map(); // Best-effort per-instance protection. Use platform WAF for production.
const securityHeaders = {
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), display-capture=()',
  'Cross-Origin-Resource-Policy':'same-origin',
  'Strict-Transport-Security':'max-age=31536000; includeSubDomains',
  'Cache-Control':'private, no-store, max-age=0',
  'Content-Security-Policy':[
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "connect-src 'self' https://*.blob.vercel-storage.com https://*.private.blob.vercel-storage.com https://blob.vercel-storage.com",
    "media-src 'self' blob:", "frame-src https://player.vdocipher.com",
    "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
  ].join('; '),
};

function send(res,status,body,type='text/plain; charset=utf-8',extra={}) {
  res.statusCode=status;
  res.setHeader('Content-Type',type);
  for(const [k,v] of Object.entries(extra)) res.setHeader(k,v);
  return res.end(body);
}
function json(res,status,obj,extra={}) { return send(res,status,JSON.stringify(obj),'application/json; charset=utf-8',extra); }
function html(res,status,title,body,script) {
  return send(res,status,page(title,body,script).replaceAll('/assets/','/'),'text/html; charset=utf-8');
}
const setCookie=(res,key,value,age)=>res.setHeader('Set-Cookie',`${key}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0,Math.floor(age))}`);
const isAdmin=req=>checkAdminCookie(parseCookies(req)[ADMIN_COOKIE],process.env.SESSION_SECRET);
function requireAdmin(req,res) {
  if(isAdmin(req))return true;
  json(res,401,{error:'Admin authentication required.'});return false;
}
const originOf=req=>`https://${req.headers.host}`;
function validOrigin(req) {
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  if(!req.headers.origin)return true;
  return req.headers.origin===originOf(req);
}
const safeHost=host=>typeof host==='string'&&(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/i.test(host)||host===process.env.APP_HOST);
function bodyObject(req) {
  if(typeof req.body==='object' && req.body!==null && !Buffer.isBuffer(req.body))return req.body;
  if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return null}}
  return null;
}
function viewerInfo(req) { return splitCustomerToken(parseCookies(req)[VIEWER_COOKIE]); }
async function requireViewer(req,res) {
  const t=viewerInfo(req);
  if(!t)return json(res,401,{error:'Viewer login required.'}),null;
  const record=await loadCustomer(t.id);
  const c=record?.data;
  if(!c || !c.active || !c.activatedAt || c.expiresAt<=now() || c.sessionHash!==hash(t.token)) {
    json(res,401,{error:'Viewing session expired, revoked or unavailable.'});return null;
  }
  return c;
}
function notReady(res){ return json(res,503,{error:'Storage is not configured. Connect a private Vercel Blob store.'}); }
function customerLink(req,customer,token){ return `${originOf(req)}/access/${customer.id}.${token}`; }
async function videoReady() {
  if(process.env.VIDEO_MODE==='vdocipher')return { mode:'vdocipher',configured:!!(process.env.VDO_CIPHER_VIDEO_ID&&process.env.VDO_CIPHER_API_SECRET),size:0 };
  const record=await loadVideoSettings();
  return {mode:'blob',configured:!!(record?.data?.size && (record?.data?.url || (record?.data?.mode === 'segments' && record?.data?.parts?.length))),size:record?.data?.size||0,video:record?.data};
}
async function vdoPlayback(req,res,customer) {
  if(!process.env.VDO_CIPHER_API_SECRET || !process.env.VDO_CIPHER_VIDEO_ID)return json(res,503,{error:'DRM provider not configured.'});
  const videoId=process.env.VDO_CIPHER_VIDEO_ID;
  const text=`VIEWER ${customer.id} ${customer.name}`.replace(/[\r\n\[\]{}]/g,' ').slice(0,90);
  const response=await fetch(`https://dev.vdocipher.com/api/videos/${encodeURIComponent(videoId)}/otp`, {
    method:'POST',signal:AbortSignal.timeout(10000),cache:'no-store',
    headers:{Authorization:`Apisecret ${process.env.VDO_CIPHER_API_SECRET}`,'Content-Type':'application/json'},
    body:JSON.stringify({ttl:300,annotate:JSON.stringify([{type:'rtext',text,alpha:'0.6',color:'0xFFFFFF',size:'18',interval:'5000',skip:'1500'}])}),
  });
  if(!response.ok)return json(res,502,{error:'Could not authorize DRM playback.'});
  const data=await response.json();
  if(!data.otp || !data.playbackInfo)return json(res,502,{error:'Invalid DRM response.'});
  const query=new URLSearchParams({otp:data.otp,playbackInfo:data.playbackInfo});
  return json(res,200,{iframeUrl:`https://player.vdocipher.com/v2/?${query}`});
}


async function streamSegmentedVideo(req, res, video) {
  const size = Number(video.size);
  const urls = video.parts;
  if (!Number.isSafeInteger(size) || size < 128 || !Array.isArray(urls) ||
      !Number.isSafeInteger(video.partBytes) || video.partBytes !== SEGMENT_BYTES ||
      urls.length !== Math.ceil(size / SEGMENT_BYTES)) {
    return json(res, 500, {error:'Private segmented video metadata is invalid.'});
  }
  const range = parseVideoRange(req.headers.range, size);
  if (!range) return send(res, 416, 'Invalid MP4 byte range', 'text/plain', {'Content-Range':'bytes */'+size});
  const {start,end} = range;
  const headers = {
    'Content-Type':'video/mp4',
    'Content-Disposition':'inline',
    'Accept-Ranges':'bytes',
    'Content-Range':'bytes '+start+'-'+end+'/'+size,
    'Content-Length':String(end-start+1),
    'Cache-Control':'private, no-store, max-age=0',
  };
  if (req.method === 'HEAD') return send(res,206,'','video/mp4',headers);
  const spans = videoSegmentSlices(start, end);
  const buffers = [];
  for (const span of spans) {
    const storedUrl = urls[span.index];
    let parsed;
    try { parsed = new URL(storedUrl); } catch { return json(res,502,{error:'Invalid private segment URL.'}); }
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.private.blob.vercel-storage.com')) {
      return json(res,502,{error:'Video segment must use private storage.'});
    }
    const response = await fetch(parsed, {
      headers:{
        'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,
        'Range':'bytes='+span.start+'-'+span.end,
      },
      cache:'no-store',
      signal:AbortSignal.timeout(25_000),
    });
    if ((response.status !== 206 && response.status !== 200) || !response.body) {
      response.body?.cancel().catch(()=>{});
      return json(res,502,{error:'Private video segment is temporarily unavailable.'});
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (response.status === 206) {
      if (data.length !== span.length) return json(res,502,{error:'Short read while playing MP4.'});
      buffers.push(data);
    } else {
      if (data.length < span.end + 1) return json(res,502,{error:'Incomplete private video segment.'});
      buffers.push(data.subarray(span.start,span.end+1));
    }
  }
  const output = Buffer.concat(buffers);
  if (output.length !== end-start+1) return json(res,502,{error:'MP4 segment data is incomplete.'});
  res.statusCode = 206;
  for (const [key,value] of Object.entries(headers)) res.setHeader(key,value);
  return res.end(output);
}

async function streamVideo(req,res) {
  const viewer=await requireViewer(req,res); if(!viewer)return;
  if(process.env.VIDEO_MODE==='vdocipher')return json(res,404,{error:'Local streaming disabled in DRM mode.'});
  const record=await loadVideoSettings();
  const video=record?.data;
  if (video?.mode === 'segments') return streamSegmentedVideo(req,res,video);
  if(!video?.url || !video?.size)return json(res,404,{error:'Video not uploaded yet.'});
  const url=new URL(video.url);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.private.blob.vercel-storage.com'))return json(res,500,{error:'Invalid private video store configuration.'});
  const size=video.size;
  const raw=req.headers.range;
  if(raw && !/^bytes=\d+-\d*$/.test(raw)) return send(res,416,'Invalid range','text/plain',{'Content-Range':`bytes */${size}`});
  const m=raw && /^bytes=(\d+)-(\d*)$/.exec(raw);
  const start=m?Number(m[1]):0;
  const requestedEnd=(m&&m[2])?Number(m[2]):size-1;
  if(!Number.isSafeInteger(start)||start>=size||!Number.isSafeInteger(requestedEnd)||requestedEnd<start) return send(res,416,'Invalid range','text/plain',{'Content-Range':`bytes */${size}`});
  const end=Math.min(start+MEDIA_CHUNK-1,requestedEnd,size-1);
  const headers={
    'Content-Type':'video/mp4','Content-Disposition':'inline','Accept-Ranges':'bytes',
    'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':String(end-start+1),
    'Cache-Control':'private, no-store, max-age=0',
  };
  if(req.method==='HEAD')return send(res,206,'','video/mp4',headers);
  const upstream=await fetch(url,{headers:{'Authorization':`Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,'Range':`bytes=${start}-${end}`},cache:'no-store'});
  if(upstream.status!==206 || !upstream.body){upstream.body?.cancel().catch(()=>{});return json(res,502,{error:'Private storage did not return the requested video range.'});}
  res.statusCode=206; for(const [key,value] of Object.entries(headers))res.setHeader(key,value);
  const stream=Readable.fromWeb(upstream.body);
  res.on('close',()=>stream.destroy());
  stream.on('error',()=>{if(!res.headersSent) json(res,502,{error:'Video transfer interrupted.'});else res.destroy();});
  stream.pipe(res);
}

export default async function handler(req,res) {
  for(const [key,value] of Object.entries(securityHeaders))res.setHeader(key,value);
  res.setHeader('Vary','Cookie');
  try {
    const requestUrl=new URL(req.url||'/', 'https://example.vercel.app');
    const route=requestUrl.searchParams.get('route')||requestUrl.pathname;
    const method=req.method;
    if(!safeHost(req.headers.host))return json(res,421,{error:'Unrecognized host.'});
    if(!process.env.SESSION_SECRET||!process.env.ADMIN_PASSWORD_HASH)return json(res,503,{error:'Admin credentials have not been configured.'});
    if(!process.env.BLOB_READ_WRITE_TOKEN && process.env.VIDEO_MODE!=='vdocipher')return notReady(res);
    if(['POST','PUT','DELETE'].includes(method)&&!validOrigin(req))return json(res,403,{error:'Cross-site requests are not allowed.'});

    if(method==='GET'&&route==='/health')return json(res,200,{ok:true,storageConfigured:!!process.env.BLOB_READ_WRITE_TOKEN,mode:process.env.VIDEO_MODE==='vdocipher'?'vdocipher':'blob'});
    if(method==='GET'&&route==='/')return html(res,200,'Private tutorial portal',HOME);
    if(method==='GET'&&route==='/admin')return isAdmin(req)?html(res,200,'Admin dashboard',ADMIN_DASH,'admin.js'):html(res,200,'Admin login',ADMIN_LOGIN,'admin.js');
    if(method==='GET'&&route==='/watch'){
      if(!await requireViewer(req,res))return;
      return html(res,200,'Watch tutorial',WATCH_PAGE,'watch.js');
    }
    const invite=/^\/access\/(CUS-[A-F0-9]{8}\.[A-Za-z0-9_-]{43})$/.exec(route);
    if(method==='GET'&&invite){
      const t=splitCustomerToken(invite[1]);
      const record=await loadCustomer(t.id);
      const c=record?.data;
      return c&&c.active&&!c.activatedAt&&c.expiresAt>now()&&c.linkHash===hash(t.token)
        ? html(res,200,'Activate your tutorial',accessPage(c,invite[1]))
        : html(res,410,'Invite unavailable',UNKNOWN);
    }
    if(method==='POST'&&route==='/api/admin/login'){
      const input=bodyObject(req);
      if(!input)return json(res,400,{error:'Expected valid JSON.'});
      const ip=String(req.headers['x-real-ip']||req.socket?.remoteAddress||'unknown').slice(0,100);
      const bucket=attempts.get(ip)||{count:0,until:0};
      if(bucket.until>now())return json(res,429,{error:'Too many attempts. Try later.'});
      if(input.username!==(process.env.ADMIN_USERNAME||'admin')||!passwordMatches(input.password,process.env.ADMIN_PASSWORD_HASH)){
        bucket.count++;if(bucket.count>=6){bucket.until=now()+15*60000;bucket.count=0;}
        attempts.set(ip,bucket);return json(res,401,{error:'Invalid username or password.'});
      }
      attempts.delete(ip);
      setCookie(res,ADMIN_COOKIE,mintAdminCookie(process.env.SESSION_SECRET),8*3600);
      return json(res,200,{ok:true});
    }
    if(method==='POST'&&route==='/api/admin/logout'){
      if(!requireAdmin(req,res))return;
      setCookie(res,ADMIN_COOKIE,'',0);
      return json(res,200,{ok:true});
    }
    if(method==='GET'&&route==='/api/admin/overview'){
      if(!requireAdmin(req,res))return;
      const [v,customers]=await Promise.all([videoReady(),listCustomers()]);
      return json(res,200,{mode:v.mode,configured:v.configured,size:v.size,customers:customers.map(publicCustomer)});
    }
    if(method==='POST'&&route==='/api/admin/customers'){
      if(!requireAdmin(req,res))return;
      const input=bodyObject(req);const name=String(input?.name||'').trim();const hours=Number(input?.hours);
      if(!name||name.length>70||!validHours(hours))return json(res,400,{error:'Enter customer name and duration (1-720 hours).'});
      const token=uid();
      const customer={id:`CUS-${randomBytes(4).toString('hex').toUpperCase()}`,name,active:true,createdAt:now(),expiresAt:now()+hours*ONE_HOUR,activatedAt:null,linkHash:hash(token),sessionHash:null};
      await saveCustomer(customer);
      return json(res,201,{customer:publicCustomer(customer),link:customerLink(req,customer,token)});
    }
    const action=/^\/api\/admin\/customers\/(CUS-[A-F0-9]{8})\/(reissue|revoke)$/.exec(route);
    if(method==='POST'&&action){
      if(!requireAdmin(req,res))return;
      const record=await loadCustomer(action[1]);if(!record)return json(res,404,{error:'Customer not found.'});
      const c=record.data;
      if(action[2]==='revoke')Object.assign(c,{active:false,linkHash:null,sessionHash:null});
      else {
        const h=Number(bodyObject(req)?.hours??24);
        if(!validHours(h))return json(res,400,{error:'Invalid duration.'});
        const token=uid();Object.assign(c,{active:true,expiresAt:now()+h*ONE_HOUR,activatedAt:null,linkHash:hash(token),sessionHash:null});
        await saveCustomer(c,record.etag);
        return json(res,200,{customer:publicCustomer(c),link:customerLink(req,c,token)});
      }
      await saveCustomer(c,record.etag);
      return json(res,200,{customer:publicCustomer(c)});
    }
    if(method==='POST'&&route==='/api/access/redeem'){
      if(!String(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'))return json(res,415,{error:'Invalid form encoding.'});
      const form=new URLSearchParams(typeof req.body==='string'?req.body:Buffer.isBuffer(req.body)?req.body.toString('utf8'):new URLSearchParams(req.body||{}).toString());
      const token=splitCustomerToken(form.get('token'));
      if(!token)return html(res,410,'Invite unavailable',UNKNOWN);
      const record=await loadCustomer(token.id);
      const c=record?.data;
      if(!c||!c.active||c.activatedAt||c.expiresAt<=now()||c.linkHash!==hash(token.token))return html(res,410,'Invite unavailable',UNKNOWN);
      const session=uid();
      Object.assign(c,{activatedAt:now(),sessionHash:hash(session),linkHash:null});
      await saveCustomer(c,record.etag);
      setCookie(res,VIEWER_COOKIE,`${c.id}.${session}`,Math.ceil((c.expiresAt-now())/1000));
      return send(res,303,'Redirecting','text/plain; charset=utf-8',{Location:'/watch'});
    }
    if(method==='GET'&&route==='/api/watch/session'){
      const c=await requireViewer(req,res);if(!c)return;
      const v=await videoReady();
      return json(res,200,{id:c.id,name:c.name,expiresAt:c.expiresAt,mode:v.mode==='vdocipher'?'vdocipher':'local',ready:v.configured});
    }
    if((method==='GET'||method==='HEAD')&&route==='/api/media/stream')return streamVideo(req,res);
    if(method==='POST'&&route==='/api/vdo/playback'){
      const c=await requireViewer(req,res);if(!c)return;
      return vdoPlayback(req,res,c);
    }

    // Same-origin fallback: the browser uploads 3 MiB at a time to this Function.
    // No browser-to-Blob cross-origin handshake is needed, and every byte stays unchanged.
    if(method==='POST'&&route==='/api/admin/video/segment-init'){
      if(!requireAdmin(req,res))return;
      const size=Number(bodyObject(req)?.size);
      if(!validVideoSize(size))return json(res,400,{error:'Select an MP4 between 128 bytes and 500 MB.'});
      const session=makeUploadTicket(size,process.env.SESSION_SECRET);
      return json(res,200,{ticket:session.ticket,partBytes:session.partBytes,partCount:session.partCount,size:session.size});
    }
    if(method==='PUT'&&route==='/api/admin/video/segment-chunk'){
      if(!requireAdmin(req,res))return;
      const session=readUploadTicket(req.headers['x-upload-ticket'],process.env.SESSION_SECRET);
      if(!session)return json(res,403,{error:'Upload session is invalid or expired. Restart the upload.'});
      const index=Number(req.headers['x-part-index']);
      const expected=expectedSegmentBytes(session,index);
      if(expected===null)return json(res,400,{error:'Invalid upload chunk index.'});
      if(!String(req.headers['content-type']||'').startsWith('application/octet-stream'))
        return json(res,415,{error:'Upload chunks must contain original binary MP4 bytes.'});
      const data=req.body;
      if(!Buffer.isBuffer(data))return json(res,400,{error:'Binary upload body could not be read. Please retry.'});
      if(data.length!==expected)return json(res,422,{error:'Video chunk size did not match the original.'});
      if(index===0 && (data.length<12||data.toString('ascii',4,8)!=='ftyp'))
        return json(res,415,{error:'This file is not a supported MP4 (missing ftyp header).'});
      await put(partPath(session,index),data,{
        access:'private',contentType:'application/octet-stream',allowOverwrite:true,
        cacheControlMaxAge:60,
      });
      return json(res,200,{ok:true,index,bytes:data.length});
    }
    if(method==='POST'&&route==='/api/admin/video/segment-finish'){
      if(!requireAdmin(req,res))return;
      const ticket=String(bodyObject(req)?.ticket||'');
      const session=readUploadTicket(ticket,process.env.SESSION_SECRET);
      if(!session)return json(res,403,{error:'Upload session expired. Please restart the upload.'});
      const parts=new Array(session.partCount);
      // Verify every part server-side before publishing the video to customers.
      for(let offset=0;offset<session.partCount;offset+=8){
        const indexes=Array.from({length:Math.min(8,session.partCount-offset)},(_,n)=>offset+n);
        const found=await Promise.all(indexes.map(async index=>{
          try { return await head(partPath(session,index)); } catch { return null; }
        }));
        for(let i=0;i<indexes.length;i++){
          const index=indexes[i], item=found[i];
          if(!item||item.size!==expectedSegmentBytes(session,index))
            return json(res,409,{error:'A video chunk is incomplete (#'+(index+1)+'). Please retry upload.'});
          const url=new URL(item.url);
          if(url.protocol!=='https:'||!url.hostname.endsWith('.private.blob.vercel-storage.com'))
            return json(res,500,{error:'Video chunk is not in private storage.'});
          parts[index]=item.url;
        }
      }
      const previous=await loadVideoSettings();
      await saveVideoSettings({
        mode:'segments',size:session.size,partBytes:session.partBytes,
        parts,updatedAt:now(),
      },previous?.etag);
      return json(res,200,{ok:true,size:session.size,segments:session.partCount});
    }

    return route.startsWith('/api/')?json(res,404,{error:'Unknown endpoint.'}):html(res,404,'Not found',UNKNOWN);
  }catch(error){
    console.error('VaultStream request error',error?.name||'Error',String(error?.message||'').slice(0,180));
    if(res.headersSent)return res.destroy();
    const status=error?.name==='BlobPreconditionFailedError'?409:500;
    return json(res,status,{error:status===409?'The record changed. Refresh and try again.':'Server error. Check Vercel configuration and logs.'});
  }
}
