#!/usr/bin/env python3
import sys,struct
_C=b'\x03\x00\x20\x03\x01\x65\x04\x05\x61\x04\x07\x69\x04\x06\x6f\x04\x04\x74\x05\x16\x63\x05\x15\x64\x05\x13\x68\x05\x14\x6c\x05\x10\x6e\x05\x12\x72\x05\x11\x73\x05\x17\x75\x06\x3b\x0a\x06\x39\x2c\x06\x3a\x2e\x06\x36\x62\x06\x32\x66\x06\x33\x67\x06\x3d\x6a\x06\x38\x6b\x06\x30\x6d\x06\x35\x70\x06\x3e\x71\x06\x37\x76\x06\x31\x77\x06\x3c\x78\x06\x34\x79'
_T={}
for _i in range(0,len(_C),3):
 _l,_v,_o=_C[_i],_C[_i+1],_C[_i+2]
 _T[tuple((_v>>(_l-1-j))&1 for j in range(_l))]=bytes([_o])
_E=(1,)*6
def _x(d,k):
 return bytes(b^((k*(i+1)+165)&255)for i,b in enumerate(d))
def _w(d):
 r=bytearray(len(d));B=16
 for o in range(0,len(d),B):
  c=d[o:o+B];n=len(c);h=(n+1)//2
  for i in range(h):r[o+i*2]=c[i]
  for i in range(h,n):r[o+(i-h)*2+1]=c[i]
 return bytes(r)
def _p(d,n):
 q=bytearray();bp=[0]
 def rb():
  if bp[0]//8>=len(d):raise ValueError
  v=(d[bp[0]//8]>>(7-bp[0]%8))&1;bp[0]+=1;return v
 def rs():
  c=()
  while 1:
   c+=(rb(),)
   if c in _T:return _T[c]
   if c==_E:
    v=0
    for _ in range(8):v=(v<<1)|rb()
    return bytes([v])
   if len(c)>14:raise ValueError
 while len(q)<n:
  bi=bp[0]//8
  if bp[0]%8==0 and bi+1<len(d) and d[bi]==255 and d[bi+1]==0:break
  f=rb()
  if f==0:q.extend(rs())
  else:
   rl=0
   for _ in range(4):rl=(rl<<1)|rb()
   q.extend(rs()*(rl+2))
 return bytes(q[:n])
def _d(z):
 n=(z[0]<<8)|z[2];s=(z[1]<<8)|z[3]
 return _p(_w(_x(z[4:],s)),n)
if __name__=='__main__':
 try:sys.stdout.buffer.write(_d(sys.stdin.buffer.read()))
 except Exception as e:print(e,file=sys.stderr);sys.exit(1)
