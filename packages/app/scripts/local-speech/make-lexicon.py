"""CMUdict BSD-licensed ARPAbet to model IPA token lexicon; no espeak executable/data."""
from pathlib import Path
import re,json,hashlib
b=Path(__file__).resolve().parent
mapping={'AA':'ɑ','AE':'æ','AH':'ʌ','AO':'ɔ','AW':'aʊ','AY':'aɪ','B':'b','CH':'tʃ','D':'d','DH':'ð','EH':'ɛ','ER':'ɜɹ','EY':'eɪ','F':'f','G':'ɡ','HH':'h','IH':'ɪ','IY':'i','JH':'dʒ','K':'k','L':'l','M':'m','N':'n','NG':'ŋ','OW':'oʊ','OY':'ɔɪ','P':'p','R':'ɹ','S':'s','SH':'ʃ','T':'t','TH':'θ','UH':'ʊ','UW':'u','V':'v','W':'w','Y':'j','Z':'z','ZH':'ʒ'}
words={}
for line in (b/'reference/cmudict.dict').read_text().splitlines():
 fields=line.split('#')[0].split()
 if not fields:continue
 word=fields[0]
 if not re.fullmatch("[a-z]+(?:'[a-z]+)?",word) or word in words:continue
 phones=[]
 for symbol in fields[1:]:
  match=re.fullmatch(r'([A-Z]+)([012]?)',symbol);assert match,symbol
  base,stress=match.groups();phone=mapping[base]
  if base=='AH' and stress=='0':phone='ə'
  if base=='ER' and stress=='0':phone='ɚ'
  if stress in ['1','2']:phones.append('ˈ' if stress=='1' else 'ˌ')
  phones.extend(phone)
 words[word]=phones
out=b/'generated';out.mkdir(exist_ok=True)
text=''.join(word+' '+' '.join(phones)+'\n' for word,phones in sorted(words.items()))
(out/'lexicon.txt').write_text(text);(out/'words.txt').write_text('\n'.join(sorted(words))+'\n')
(out/'lexicon-provenance.json').write_text(json.dumps({'entries':len(words),'source':'https://github.com/cmusphinx/cmudict/tree/74790861f652b15e4ac49015a90074ad62a27690','license':'BSD-2-Clause','inputSha256':hashlib.sha256((b/'reference/cmudict.dict').read_bytes()).hexdigest(),'outputSha256':hashlib.sha256(text.encode()).hexdigest(),'warning':'Deterministic ARPAbet to IPA conversion. Stress placement and pronunciation require listening qualification; no accent-quality claim.'},indent=2)+'\n')
print(len(words),'lexicon entries',len(text.encode()),'bytes')
