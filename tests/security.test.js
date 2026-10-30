import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes, scryptSync } from 'node:crypto';
import {mintAdminCookie,checkAdminCookie,passwordMatches,splitCustomerToken,validHours,publicCustomer,uid,hash} from '../lib/security.js';

test('admin cookies are signed and expire', () => {
  const secret=uid()+uid();
  const cookie=mintAdminCookie(secret);
  assert.equal(checkAdminCookie(cookie,secret),true);
  assert.equal(checkAdminCookie(cookie.slice(0,-1)+'x',secret),false);
  assert.equal(checkAdminCookie(mintAdminCookie(secret,Date.now()-1000),secret),false);
  assert.equal(checkAdminCookie(cookie,uid()+uid()),false);
});

test('scrypt admin password verification',()=>{
  const salt=randomBytes(16);
  const encoded=`scrypt:${salt.toString('hex')}:${scryptSync('a secret string',salt,64).toString('hex')}`;
  assert.equal(passwordMatches('a secret string',encoded),true);
  assert.equal(passwordMatches('wrong',encoded),false);
  assert.equal(passwordMatches('anything',''),false);
});

test('invite token cannot be confused with customer ID',()=>{
  const token=uid();
  const pair=splitCustomerToken('CUS-ABCDEF01.'+token);
  assert.equal(pair?.id,'CUS-ABCDEF01');
  assert.equal(pair?.token,token);
  assert.equal(splitCustomerToken('CUS-ABCDEF01.'+token+'evil'),null);
  assert.equal(splitCustomerToken('x'),null);
  assert.equal(hash(token).length,64);
  assert.equal(validHours(24),true);
  assert.equal(validHours(0),false);
});

test('customer state reflects revocation and expiry',()=>{
  const c={id:'CUS-ABCDEF01',name:'Customer',active:true,createdAt:1,expiresAt:Date.now()+10000,activatedAt:null};
  assert.equal(publicCustomer(c).status,'pending');
  c.activatedAt=Date.now(); assert.equal(publicCustomer(c).status,'activated');
  c.active=false; assert.equal(publicCustomer(c).status,'revoked');
});
