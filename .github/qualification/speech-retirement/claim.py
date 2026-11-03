"""Validate a pre-dispatch intent and bind it to the actual GitHub run.

No source checkout, install, model, provider, test, Docker or financial operation.
The workflow uploads this claim before checkout/execution. Concurrency uses the
same repository-wide intent name; an existing claim forbids another run.
"""
import hashlib,json,os,pathlib,re,time,urllib.request,urllib.parse
P=pathlib.Path(__file__).resolve().parent
assert os.environ['GITHUB_RUN_ATTEMPT']=='1'
assert os.environ['GITHUB_SHA']==os.environ['EXPECTED_WORKFLOW_SHA']
text=os.environ['ROOT_GO_TEXT'];assert len(text)<65536
go=json.loads(text);manifest=json.loads((P/'SOURCE-MANIFEST.json').read_text())
assert go['action']=='ONE_EXACT_QUALIFICATION_RUN' and go['recipe']=='ack-normal-fullfiles' and go['mode']=='qualify' and go['allowHostedFrozenLockSetup'] is True
assert go['mode']==os.environ['QUALIFICATION_MODE']
assert go['workflowCommit']==os.environ['GITHUB_SHA']
assert go['sourceCommit']==manifest['commit'] and go['sourceTree']==manifest['tree']
plan=json.loads((P/'PLAN.json').read_text())
assert go['expectedRegistrations']==1122 and go['expectedPassed']==1121 and go['expectedManualUnexecuted']==1
assert go['manualTracePolicy']=='unexecuted-no-inputs'
assert go['operatorSealSHA256']==hashlib.sha256((P/'SEAL.json').read_bytes()).hexdigest()
assert re.fullmatch('[a-f0-9]{32}',go['intentId'])
now=time.time()
assert 0<go['issuedEpoch']<=now<go['expiresEpoch']<=go['issuedEpoch']+1200
assert str(go['expiresEpoch'])==os.environ['EXPIRES_EPOCH']
temp=pathlib.Path(os.environ['RUNNER_TEMP']).resolve()
assert go['output']==str(temp/'speech-retirement-results')
assert os.environ['GITHUB_REPOSITORY']=='elizaOS/eliza'
name='speech-intent-'+go['intentId']
url='https://api.github.com/repos/elizaOS/eliza/actions/artifacts?'+urllib.parse.urlencode({'name':name,'per_page':100})
request=urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
with urllib.request.urlopen(request,timeout=20) as response: result=json.load(response)
assert result['total_count']==0 and not result['artifacts'],'Intent already claimed or history ambiguous'
go_path=temp/'speech-root-go.json'
with go_path.open('x',encoding='utf-8',newline='') as f:f.write(text)
claim={'intentId':go['intentId'],'actualRunId':os.environ['GITHUB_RUN_ID'],'attempt':1,
 'workflowCommit':os.environ['GITHUB_SHA'],'sourceCommit':manifest['commit'],'sourceTree':manifest['tree'],
 'operatorSealSHA256':go['operatorSealSHA256'],'rootGOsha256':hashlib.sha256(text.encode()).hexdigest(),
 'claimedEpoch':now,'expiresEpoch':go['expiresEpoch'],'mode':go['mode'],'recipe':go['recipe'],'output':go['output'],'allowHostedFrozenLockSetup':go['allowHostedFrozenLockSetup'],'issuedEpoch':go['issuedEpoch'],'expectedRegistrations':go['expectedRegistrations'],'expectedPassed':go['expectedPassed'],'expectedManualUnexecuted':go['expectedManualUnexecuted'],'manualTracePolicy':go['manualTracePolicy']}
with (temp/'speech-intent-claim.json').open('x') as f:json.dump(claim,f,indent=2)
with pathlib.Path(os.environ['GITHUB_OUTPUT']).open('a') as f:f.write('intent_id='+go['intentId']+'\n')
