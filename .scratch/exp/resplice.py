# usage: python3 resplice.py <verify.dfy> <lemmas.dfy> <out.dfy>
# Replaces each lemma of lemmas.dfy that the verify file declares (header and body), and inserts the others
# before `module ProofLib` (or at the end).
import re, sys
s = open(sys.argv[1]).read()
new = open(sys.argv[2]).read()
def lemmas(text):
    out = []
    for m in re.finditer(r'^(?://[^\n]*\n)*lemma (\w+)', text, re.M):
        start = m.start()
        i = text.index('\n{\n', m.end())
        depth = 0; j = i + 1
        while True:
            c = text[j]
            if c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0: break
            j += 1
        out.append((m.group(1), start, j + 1))
    return out
add = []
for name, a, b in lemmas(new):
    body = new[a:b]
    m = re.search(r'^lemma ' + name + r'\(', s, re.M)
    if m:
        olds = [x for x in lemmas(s) if x[0] == name][0]
        s = s[:olds[1]] + body + s[olds[2]:]
    else:
        add.append(body)
k = s.find('\nmodule ProofLib')
k = k if k >= 0 else len(s)
s = s[:k] + '\n' + '\n\n'.join(add) + '\n' + s[k:]
open(sys.argv[3], 'w').write(s)
