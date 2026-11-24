# usage: python3 mkproof.py <generated.dfy> <bodies.txt> <helpers.dfy|-> <out.proof.dfy>
import re, sys
s = open(sys.argv[1]).read()
bodies = {}; cur = None; order = []
for line in open(sys.argv[2]).read().split('\n'):
    if re.match(r'^\w+_ensures$', line): cur = line; bodies[cur] = []; order.append(cur)
    elif cur is not None: bodies[cur].append(line)
out = []
if sys.argv[3] != '-': out.append(open(sys.argv[3]).read().rstrip() + '\n')
for name in order:
    i = s.index('lemma ' + name + '(')
    j = s.index('\n{', i)
    out.append(s[i:j] + '\n' + '\n'.join(bodies[name]).rstrip() + '\n')
open(sys.argv[4], 'w').write('\n'.join(out))
