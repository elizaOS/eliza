import {expect,test} from 'vitest';
import {SecretSwapSession} from '../security/secret-swap';
import {GuardedStreamScanner} from '../security/guarded-stream';
for(const value of ['alpha bravo','alpha"bravo','alpha\\bravo','alpha\nbravo',"alpha'bravo",'密钥 bravo'])test(`whole JSON credential span: ${JSON.stringify(value)}`,()=>{
 const input=JSON.stringify({password:value,description:'ordinary public prose'}),session=new SecretSwapSession(),wire=session.substituteText(input);
 expect(wire).not.toContain('bravo');expect(JSON.parse(wire).description).toBe('ordinary public prose');expect(session.restoreText(wire)).toBe(input);expect(session.restoreUserReplyText(wire)).not.toContain('bravo');expect(session.substituteText(wire)).toBe(wire);
});
for(const input of ['password="alpha bravo"',"password='alpha bravo'",'"client_secret": "alpha\\"bravo"',"'passphrase'='alpha\\'bravo'"])test(`quoted assignment: ${input}`,()=>{
 const session=new SecretSwapSession(),wire=session.substituteText(input);expect(wire).not.toContain('bravo');expect(session.restoreText(wire)).toBe(input);
});
test('ordinary quoted schema fields remain unchanged',()=>{const s=new SecretSwapSession(),text=JSON.stringify({tokenId:'alpha bravo',description:'alpha bravo'});expect(s.substituteText(text)).toBe(text);});
test('every quoted credential stream split protects the complete tail',()=>{
 for(const input of ['password="alpha bravo"',JSON.stringify({password:'alpha"bravo'})])for(let split=1;split<input.length;split++){
  const session=new SecretSwapSession(),scanner=new GuardedStreamScanner({secretSession:session}),parts=[scanner.push('Public padding '.repeat(100)+input.slice(0,split)),scanner.push(input.slice(split)),scanner.flush()];expect(parts.map(p=>p.safe).join('')).not.toContain('bravo');expect(parts.map(p=>p.visible).join('')).not.toContain('bravo');
 }
});
