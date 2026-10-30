import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SEGMENT_BYTES, MAX_VIDEO_BYTES, DELIVERY_BYTES,
  validVideoSize, makeUploadTicket, readUploadTicket,
  expectedSegmentBytes, partPath, parseVideoRange, videoSegmentSlices,
} from '../lib/segmented-video.js';

const SECRET = 'a-long-random-looking-application-secret-containing-more-than-40-characters';

test('signed upload tickets cannot be forged or used outside their expiry', () => {
  const time = 1_800_000_000_000;
  const upload = makeUploadTicket(274 * 1024 * 1024, SECRET, time);
  const info = readUploadTicket(upload.ticket, SECRET, time + 1000);
  assert.equal(info.id, upload.id);
  assert.equal(info.partCount, Math.ceil(upload.size / SEGMENT_BYTES));
  assert.equal(readUploadTicket(upload.ticket + 'x', SECRET, time + 1000), null);
  assert.equal(readUploadTicket(upload.ticket, 'another-private-secret-that-is-longer-than-40-characters', time), null);
  assert.equal(readUploadTicket(upload.ticket, SECRET, time + 5 * 60 * 60 * 1000), null);
  assert.equal(readUploadTicket(upload.ticket, SECRET, time - 3600000), null);
});

test('only supported original MP4 file sizes are accepted', () => {
  assert.equal(validVideoSize(128), true);
  assert.equal(validVideoSize(MAX_VIDEO_BYTES), true);
  assert.equal(validVideoSize(MAX_VIDEO_BYTES + 1), false);
  assert.equal(validVideoSize(0), false);
  assert.equal(validVideoSize(NaN), false);
});

test('3MiB parts accurately represent a 274.5MiB source', () => {
  const size = 274.5 * 1024 * 1024;
  const info = makeUploadTicket(size, SECRET);
  const last = info.partCount - 1;
  let total = 0;
  for (let i = 0; i < info.partCount; i++) {
    const segmentSize = expectedSegmentBytes(info, i);
    assert.ok(segmentSize > 0 && segmentSize <= SEGMENT_BYTES);
    total += segmentSize;
    assert.match(partPath(info, i), /^video-segments\/[0-9a-f]{32}\/part-\d{4}\.bin$/);
  }
  assert.equal(total, size);
  assert.equal(expectedSegmentBytes(info, info.partCount), null);
  assert.throws(() => partPath(info, info.partCount));
});

test('iPhone video HTTP ranges are bounded and split at private segment boundaries', () => {
  const size = 274 * 1024 * 1024;
  assert.deepEqual(parseVideoRange('bytes=0-', size), { start: 0, end: DELIVERY_BYTES - 1 });
  assert.deepEqual(parseVideoRange('bytes=-100', size), { start: size - 100, end: size - 1 });
  assert.deepEqual(parseVideoRange('bytes=999999999-', size), null);
  assert.deepEqual(parseVideoRange('bytes=abc-xyz', size), null);
  assert.deepEqual(parseVideoRange('bytes=0-0', size), { start: 0, end: 0 });
  assert.deepEqual(videoSegmentSlices(SEGMENT_BYTES - 12, SEGMENT_BYTES + 7), [
    { index: 0, start: SEGMENT_BYTES - 12, end: SEGMENT_BYTES - 1, length: 12 },
    { index: 1, start: 0, end: 7, length: 8 },
  ]);
});

test('slicing and reassembling authentic source bytes never changes video quality', () => {
  const source = Buffer.alloc(SEGMENT_BYTES * 2 + 23);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;
  const saved = [];
  for (let p = 0; p < Math.ceil(source.length / SEGMENT_BYTES); p++)
    saved.push(Buffer.from(source.subarray(p * SEGMENT_BYTES, (p + 1) * SEGMENT_BYTES)));
  const start = SEGMENT_BYTES - 5, end = SEGMENT_BYTES + 8;
  const restored = Buffer.concat(videoSegmentSlices(start, end).map(span =>
    saved[span.index].subarray(span.start, span.end + 1)));
  assert.deepEqual(restored, source.subarray(start, end + 1));
  assert.deepEqual(Buffer.concat(saved), source);
});
