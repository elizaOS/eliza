# usage: python3 build.py <generated.dfy> <bodies.txt> <new.dfy> <out.dfy>
import re, sys
s = open(sys.argv[1]).read()
bodies = {}; cur = None
for line in open(sys.argv[2]).read().split('\n'):
    if re.match(r'^\w+_ensures$', line): cur = line; bodies[cur] = []
    elif cur is not None: bodies[cur].append(line)
for name, body in bodies.items():
    body = '\n'.join(body).rstrip()
    i = s.index('lemma ' + name + '(')
    j = s.index('\n{\n}\n', i)
    s = s[:j] + '\n' + body + '\n' + s[j + len('\n{\n}\n'):]
s += '\n' + open(sys.argv[3]).read()
open(sys.argv[4], 'w').write(s)
