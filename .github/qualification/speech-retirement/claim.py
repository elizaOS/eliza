"""Finite source-bound one-use claim. No test/module/setup is executed here."""
import hashlib,json,os,pathlib,re,time,urllib.request,urllib.parse
P=pathlib.Path(__file__).resolve().parent
assert os.environ['GITHUB_RUN_ATTEMPT']=='1' and os.environ['GITHUB_EVENT_NAME']=='workflow_dispatch' and os.environ['GITHUB_REPOSITORY']=='elizaOS/eliza'
assert os.environ['GITHUB_SHA']==os.environ['EXPECTED_WORKFLOW_SHA']
text=os.environ['ROOT_GO_TEXT'];assert len(text)<65536
go=json.loads(text);manifest=json.loads((P/'SOURCE-MANIFEST.json').read_text());plan=json.loads((P/'PLAN.json').read_text())
assert re.fullmatch('[a-f0-9]{40}',manifest['commit']) and re.fullmatch('[a-f0-9]{40}',manifest['tree']),'Unpublished test successor not admitted'
assert go['action']=='ONE_EXACT_QUALIFICATION_RUN' and go['recipe']=='ordinal-normal-producer-qualification' and go['mode']=='qualify'
assert go['allowHostedFrozenLockSetup'] is True and go['allowHostedWholeFileTests'] is True and go['allowLoopbackWireFixture'] is True
assert go['diagnosticOnly'] is False and go['allowNormalOwnedWorkspaceProducers'] is True and go['allowProducerSourceWrite'] is True and go['allowOrdinaryCLIObservation'] is True and go['allowPostCLIValuePreflight'] is True
assert go['allowHostedUnusedAndroidCleanup'] is False and go['allowExternalProviders'] is False and go['allowSourceOverlay'] is False
assert go['workflowCommit']==os.environ['GITHUB_SHA'] and go['sourceCommit']==manifest['commit'] and go['sourceTree']==manifest['tree']
assert go['expectedRegistrations']==go['expectedPassed']==plan['expectedRegistrations']==113 and go['expectedUnexecuted']==0
assert go['operatorSealSHA256']==hashlib.sha256((P/'SEAL.json').read_bytes()).hexdigest()
for key,n in [('planSHA256','PLAN.json'),('oracleSHA256','ORACLES.json'),('testResourcePolicySHA256','TEST-RESOURCE-POLICY.json'),('hostCohortsSHA256','HOST-COHORTS.json'),('sourceManifestSHA256','SOURCE-MANIFEST.json'),('producerGraphSHA256','EXPECTED-GRAPH.json'),('sourceCustodySHA256','SOURCE-CUSTODY.json')]:assert go[key]==hashlib.sha256((P/n).read_bytes()).hexdigest()
assert re.fullmatch('[a-f0-9]{32}',go['intentId'])
now=time.time();assert 0<go['issuedEpoch']<=now<go['expiresEpoch']<=go['issuedEpoch']+1200
assert str(go['expiresEpoch'])==os.environ['EXPIRES_EPOCH'] and go['mode']==os.environ['QUALIFICATION_MODE']
name='speech-intent-'+go['intentId']
url='https://api.github.com/repos/elizaOS/eliza/actions/artifacts?'+urllib.parse.urlencode({'name':name,'per_page':100})
request=urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
with urllib.request.urlopen(request,timeout=20) as response:result=json.load(response)
assert result['total_count']==0 and not result['artifacts'],'Intent already claimed or history ambiguous'
assert time.time()<go['expiresEpoch']
host_policy=json.loads((P/'HOST-COHORTS.json').read_text());runner_metadata={}
assert go['hostProvenanceDisclosure']==plan['hostProvenanceDisclosure']
for key,spec in host_policy['metadataFields'].items():
 value=os.environ.get(spec['environment']);runner_metadata[key]=value if value is None or len(value)<=spec['maxChars'] else {'overBound':True,'length':len(value)}
metadata_text=json.dumps({'state':'OBSERVED_RUNNER_METADATA_NOT_ADMISSION_OR_TEST_PASS','fields':runner_metadata},indent=2)+'\n'
assert len(metadata_text.encode())<=4096
temp=pathlib.Path(os.environ['RUNNER_TEMP']).resolve();go_path=temp/'speech-root-go.json'
with(temp/'ordinal-admission.json').open('x')as f:f.write(metadata_text)

with go_path.open('x') as f:f.write(text)
claim={'actualRunId':os.environ['GITHUB_RUN_ID'],'attempt':1,'claimedEpoch':now,'runnerMetadataSHA256':hashlib.sha256(metadata_text.encode()).hexdigest(),'rootGOsha256':hashlib.sha256(text.encode()).hexdigest()}
for key in ['intentId','workflowCommit','sourceCommit','sourceTree','operatorSealSHA256','recipe','mode','output','diagnosticOnly','allowNormalOwnedWorkspaceProducers','allowProducerSourceWrite','producerGraphSHA256','sourceCustodySHA256','allowOrdinaryCLIObservation','allowPostCLIValuePreflight','allowHostedFrozenLockSetup','allowHostedWholeFileTests','allowLoopbackWireFixture','allowHostedUnusedAndroidCleanup','allowExternalProviders','allowSourceOverlay','expectedRegistrations','expectedPassed','expectedUnexecuted','planSHA256','oracleSHA256','testResourcePolicySHA256','hostCohortsSHA256','sourceManifestSHA256','hostProvenanceDisclosure','issuedEpoch','expiresEpoch']:claim[key]=go[key]
with (temp/'speech-intent-claim.json').open('x') as f:json.dump(claim,f,indent=2)
with pathlib.Path(os.environ['GITHUB_OUTPUT']).open('a') as f:f.write('intent_id='+go['intentId']+'\n')
