import { get, put, list, head } from '@vercel/blob';

const CUSTOMER_PREFIX = 'customers/';
export const customerPath = id => `${CUSTOMER_PREFIX}${id}.json`;
export const videoSettingsPath = 'settings/current-video.json';

async function fromJson(pathname) {
  const response = await get(pathname, { access:'private', useCache:false });
  if (!response || response.statusCode !== 200 || !response.stream) return null;
  const contents = await new Response(response.stream).text();
  return { data:JSON.parse(contents), etag:response.blob.etag };
}

async function toJson(pathname, data, previousEtag) {
  const opts = {
    access:'private', contentType:'application/json',
    cacheControlMaxAge:60,
    ...(previousEtag ? {allowOverwrite:true, ifMatch:previousEtag} : {}),
  };
  return put(pathname, JSON.stringify(data), opts);
}

export const loadCustomer = id => fromJson(customerPath(id));
export const loadVideoSettings = () => fromJson(videoSettingsPath);
export const saveCustomer = (item, previousEtag) => toJson(customerPath(item.id), item, previousEtag);
export const saveVideoSettings = (item, previousEtag) => toJson(videoSettingsPath, item, previousEtag);
export const findUploadedVideo = pathname => head(pathname);

export async function listCustomers() {
  const results = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const r = await list({prefix:CUSTOMER_PREFIX,limit:100, ...(cursor ? {cursor} : {})});
    results.push(...r.blobs.filter(b=>/^customers\/CUS-[A-F0-9]{8}\.json$/.test(b.pathname)));
    if (!r.hasMore) break;
    cursor = r.cursor;
  }
  const customers = await Promise.all(results.map(async item => {
    const id = item.pathname.split('/').pop().slice(0, -5);
    try { return (await loadCustomer(id))?.data ?? null; } catch { return null; }
  }));
  return customers.filter(Boolean).sort((a,b) => b.createdAt - a.createdAt);
}
