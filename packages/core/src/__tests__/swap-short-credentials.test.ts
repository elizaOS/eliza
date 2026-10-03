import {expect, test} from 'vitest';
import {SecretSwapSession} from '../security/secret-swap';
import {GuardedStreamScanner} from '../security/guarded-stream';

for (const value of ['a', '1', 'abc123', 'a+b', ':', '$', '_', 'SECRET']) {
  test(`short named credential is substituted without damaging syntax: ${value}`, () => {
    const s = new SecretSwapSession();
    const original = JSON.stringify({password: value, description: 'ordinary alphabet abc123suffix and SECRETsuffix', count: 12});
    const wire = s.substituteText(original);
    const parsed = JSON.parse(wire);
    expect(parsed.password).toMatch(/^__ELIZA_SECRET_[a-f0-9]{16}_\d+__$/);
    expect(parsed.description).toBe('ordinary alphabet abc123suffix and SECRETsuffix');
    expect(parsed.count).toBe(12);
    expect(s.substituteText(wire)).toBe(wire);
    expect(s.restoreText(wire)).toBe(original);
    expect(JSON.parse(s.restoreUserReplyText(wire)).password).toBe('[redacted credential]');
  });
}
test('configured short credentials protect exact values and tokens, without substring replacement', () => {
  const s = new SecretSwapSession({knownSecrets:{password:'abc123'}});
  const input = {value:'abc123',text:'Use abc123. Retain abc123suffix and preabc123.'};
  const wire = s.substituteInValue(input);
  expect(wire.value).toMatch(/^__ELIZA_SECRET_/);
  expect(wire.text).not.toContain('Use abc123.');
  expect(wire.text).toContain('abc123suffix and preabc123');
  expect(s.restoreInValue(wire)).toEqual(input);
});
test('short credentials neither corrupt contact references nor suppress unrelated contact data', () => {
  const s = new SecretSwapSession({knownSecrets:{password:'a',pin:'1'}});
  const email='alpha.redaction.probe@example.invalid';
  const wire=s.substituteText(`password=a pin=1 Contact ${email}`);
  expect(s.substituteText(wire)).toBe(wire);
  expect(s.restoreUserReplyText(wire)).toContain(email);
  expect(s.restoreUserReplyText(wire)).toContain('password=[redacted credential]');
});
test('all streaming splits keep named short credentials off both output channels', () => {
  for(const value of ['abc123','a+b',':']) {
    const text=`Context. ${JSON.stringify({password:value})} End.`;
    for(let split=1;split<text.length;split++) {
      const s=new SecretSwapSession(), scanner=new GuardedStreamScanner({secretSession:s});
      const parts=[scanner.push('Padding '.repeat(100)+text.slice(0,split)),scanner.push(text.slice(split)),scanner.flush()];
      expect(parts.map(p=>p.safe).join('')).not.toContain(`"password":"${value}"`);
      expect(parts.map(p=>p.visible).join('')).toContain('"password":"[redacted credential]"');
    }
  }
});

test('structured credential keys are learned before earlier references are substituted', () => {
  const s=new SecretSwapSession();
  const input={echo:'abc123',nested:[{password:'abc123'}],other:'abc123suffix'};
  const wire=s.substituteInValue(input);
  expect(wire.echo).toMatch(/^__ELIZA_SECRET_/);
  expect(wire.nested[0].password).toBe(wire.echo);
  expect(wire.other).toBe('abc123suffix');
  expect(s.restoreInValue(wire)).toEqual(input);
  expect(s.restoreUserReplyText(wire.echo)).toBe('[redacted credential]');
});

test('schema field-name metadata is not classified as credential material', () => {
  const s=new SecretSwapSession();
  const input={schema:{properties:{shouldRespond:{type:'boolean'},replyText:{type:'string'}},required:['shouldRespond','replyText']},metadata:[{key:'shouldRespond'},{key:'replyText'}],password:'abc123',maxTokens:1000,tokenId:'transport-correlation'};
  const wire=s.substituteInValue(input);
  expect(wire.schema).toEqual(input.schema);
  expect(wire.metadata).toEqual(input.metadata);
  expect(wire.maxTokens).toBe(1000);
  expect(wire.tokenId).toBe('transport-correlation');
  expect(wire.password).toMatch(/^__ELIZA_SECRET_/);
});
