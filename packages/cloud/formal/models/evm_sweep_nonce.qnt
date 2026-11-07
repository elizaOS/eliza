// Repair contract for direct-wallet-payments.ts prepareEvmSweep,
// processSweepForPayment and submitPreparedEvmSweep. Not current implementation.
// One wallet/network; two durable outboxes; chain nonces 0..2; one unrelated
// pending transaction. Signed bytes are immutable and their identity is the
// (outbox, nonce) pair. A chain receipt is trusted only when its hash matches.
// Signing+persisting under the wallet transaction is atomic; before-commit
// crashes have no durable or provider effect. After-commit crashes retain bytes.
// No throughput/liveness, arbitrary reorg, RPC honesty, cryptography or byte-level
// TypeScript refinement proof. Account deletion/purge is not modeled. The legacy nonce collision is an excluded witness.
module evm_sweep_nonce {
  pure val jobs=Set(0,1)
  type State={phase:int->str,nonce:int->int,submitted:Set[int],mined:Set[int],
    chainNonce:int,rpcPending:int,walletOwner:int}
  var s:State
  action init=s'={phase:jobs.mapBy(_=>"pending"),nonce:jobs.mapBy(_=> -1),
    submitted:Set(),mined:Set(),chainNonce:0,rpcPending:0,walletOwner:-1}
  def canPrepare(i:int):bool=s.phase.get(i)=="pending" and s.walletOwner == -1
    and s.rpcPending==s.chainNonce and s.chainNonce<2
  action persist(i:int):bool=all{canPrepare(i),
    s'=s.with("phase",s.phase.set(i,"prepared")).with("nonce",s.nonce.set(i,s.chainNonce))
      .with("walletOwner",i)}
  action send(i:int):bool=all{s.walletOwner==i,s.phase.get(i)=="prepared",
    s'=s.with("submitted",s.submitted.union(Set(i)))
      .with("rpcPending",if(s.nonce.get(i)==s.chainNonce) s.chainNonce+1 else s.rpcPending)}
  action mine(i:int):bool=all{s.submitted.contains(i),not(s.mined.contains(i)),s.nonce.get(i)==s.chainNonce,
    s'=s.with("mined",s.mined.union(Set(i))).with("chainNonce",s.chainNonce+1)}
  action acknowledge(i:int):bool=all{s.walletOwner==i,s.mined.contains(i),
    s'=s.with("phase",s.phase.set(i,"confirmed")).with("walletOwner",-1)}
  // Provider acknowledgement loss and worker death do not erase durable bytes.
  action crash=s'=s
  action unrelatedPending=all{s.walletOwner == -1,s.chainNonce<2,s.rpcPending==s.chainNonce,
    s'=s.with("rpcPending",s.chainNonce+1)}
  action unrelatedMined=all{s.walletOwner == -1,s.rpcPending>s.chainNonce,
    s'=s.with("chainNonce",s.chainNonce+1)}
  action unrelatedDropped=all{s.walletOwner == -1,s.rpcPending>s.chainNonce,
    s'=s.with("rpcPending",s.chainNonce)}
  action idle=s'=s
  action step={nondet i=jobs.oneOf();any{persist(i),send(i),mine(i),acknowledge(i),crash,
    unrelatedPending,unrelatedMined,unrelatedDropped,idle}}
  val uniqueNonce=jobs.forall(i=>jobs.forall(j=>i==j or s.nonce.get(i) == -1
    or s.nonce.get(j) == -1 or s.nonce.get(i)!=s.nonce.get(j)))
  val safety=uniqueNonce
    and jobs.forall(i=>s.phase.get(i)!="confirmed" or s.mined.contains(i))
    and (s.walletOwner == -1 or s.phase.get(s.walletOwner)=="prepared")
  run oneWalletSerializesTwoOutboxesTest=init.then(persist(0)).then(send(0)).then(mine(0)).then(acknowledge(0))
    .then(persist(1)).then(send(1)).then(mine(1)).then(acknowledge(1))
    .expect(safety and s.nonce.get(0)==0 and s.nonce.get(1)==1)
  run crashedPreparedOutboxRetainsWalletTest=init.then(persist(0)).then(crash)
    .expect(safety and not(canPrepare(1)) and s.nonce.get(0)==0)
  run lostSubmissionAckResendsSameIdentityTest=init.then(persist(0)).then(send(0)).then(crash).then(send(0)).then(mine(0)).then(send(0)).then(acknowledge(0))
    .expect(safety and s.mined.size()==1 and s.nonce.get(0)==0)
  run pendingProviderNonceCannotBeSkippedTest=init.then(unrelatedPending)
    .expect(safety and not(canPrepare(0)) and not(canPrepare(1)))
  run minedUnrelatedNonceAllowsCurrentConfirmedNonceTest=init.then(unrelatedPending).then(unrelatedMined).then(persist(0))
    .expect(safety and s.nonce.get(0)==1)
  run droppedUnrelatedPendingCreatesNoGapTest=init.then(unrelatedPending).then(unrelatedDropped).then(persist(0))
    .expect(safety and s.nonce.get(0)==0)
  // Current code selects a pending nonce independently per outbox. No shared
  // wallet owner is recorded, so two prepared byte identities can collide.
  action legacyPersist(i:int):bool=all{s.phase.get(i)=="pending",
    s'=s.with("phase",s.phase.set(i,"prepared")).with("nonce",s.nonce.set(i,s.rpcPending))}
  run independentOutboxClaimsDoNotReserveWalletNegativeWitnessTest=init.then(legacyPersist(0)).then(legacyPersist(1))
    .expect(not(uniqueNonce))
}
