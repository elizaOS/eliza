"""Paired version of existing repository-wide immutable single-use claim. Draft only."""
import hashlib,json,os,pathlib,re,shutil,time,urllib.request,urllib.parse
P=pathlib.Path(__file__).resolve().parent
plan=json.loads((P/"PLAN.json").read_text());assert plan["state"]=="FROZEN_REVIEWED_READY", "Source draft is not dispatchable"
assert os.environ["GITHUB_RUN_ATTEMPT"]=="1" and os.environ["RUNNER_ENVIRONMENT"]=="github-hosted"
assert os.environ["GITHUB_REPOSITORY"]=="elizaOS/eliza" and os.environ["GITHUB_EVENT_NAME"]=="workflow_dispatch"
assert os.environ["GITHUB_SHA"]==os.environ["EXPECTED_WORKFLOW_SHA"]
text=os.environ["ROOT_GO_TEXT"];assert len(text)<65536;go=json.loads(text)
assert go["action"]=="ONE_EXACT_QUALIFICATION_RUN" and go["mode"]=="qualify" and go["recipe"]=="paired-voice-terminal-normal-v2"
assert go["sources"]==plan["candidates"] and go["workflowCommit"]==os.environ["GITHUB_SHA"] and go["allowHostedFrozenLockSetup"] is True and go["allowPinnedGitBootstrapBeforeAlphaAncestry"] is True
assert re.fullmatch("[a-f0-9]{32}",go["intentId"])
assert 0<go["issuedEpoch"]<=time.time()<go["expiresEpoch"]<=go["issuedEpoch"]+1200 and str(go["expiresEpoch"])==os.environ["EXPIRES_EPOCH"]
assert os.environ["QUALIFICATION_MODE"]=="qualify"
for key,name in [("operatorSealSHA256","SEAL.json"),("sourceManifestSHA256","SOURCE-MANIFEST.json"),("oracleSHA256","ORACLES.json"),("resourcePolicySHA256","TEST-RESOURCE-POLICY.json"),("toolchainSHA256","TOOLCHAIN.json")]:assert go[key]==hashlib.sha256((P/name).read_bytes()).hexdigest()
seal=json.loads((P/"SEAL.json").read_text())["files"]
for name,digest in seal.items():assert hashlib.sha256((P/name).read_bytes()).hexdigest()==digest
assert {"claim.py","run.py","PLAN.json","workflow.yml","SOURCE-MANIFEST.json","ORACLES.json","TOOLCHAIN.json","TEST-RESOURCE-POLICY.json"}.issubset(seal)
temp=pathlib.Path(os.environ["RUNNER_TEMP"]).resolve();assert go["output"]==str(temp/"paired-voice-results")
free=shutil.disk_usage(temp).free;assert free>=17179869184
name="speech-intent-"+go["intentId"]
url="https://api.github.com/repos/elizaOS/eliza/actions/artifacts?"+urllib.parse.urlencode({"name":name,"per_page":100})
request=urllib.request.Request(url,headers={"Authorization":"Bearer "+os.environ["GH_TOKEN"],"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"})
with urllib.request.urlopen(request,timeout=20) as response:existing=json.load(response)
assert existing["total_count"]==0 and not existing["artifacts"],"Intent already used or artifact history ambiguous"
with(temp/"speech-root-go.json").open("x",encoding="utf-8",newline="")as f:f.write(text)
claim={key:go[key]for key in ["intentId","sources","workflowCommit","operatorSealSHA256","sourceManifestSHA256","oracleSHA256","resourcePolicySHA256","toolchainSHA256","issuedEpoch","expiresEpoch","output","recipe","mode","allowHostedFrozenLockSetup","allowPinnedGitBootstrapBeforeAlphaAncestry"]}
claim.update(actualRunId=os.environ["GITHUB_RUN_ID"],attempt=1,rootGOsha256=hashlib.sha256(text.encode()).hexdigest(),claimedEpoch=time.time(),diskAvailableBytesAtClaim=free)
with(temp/"speech-intent-claim.json").open("x")as f:json.dump(claim,f,indent=2);f.write("\n")
with pathlib.Path(os.environ["GITHUB_OUTPUT"]).open("a")as f:f.write("intent_id="+go["intentId"]+"\n")
