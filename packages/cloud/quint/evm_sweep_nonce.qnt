// Repair contract for direct-wallet-payments.ts prepareEvmSweep,
// processSweepForPayment and submitPreparedEvmSweep, plus the deletion trigger.
// One original wallet/network, one configuration rotation, two durable outboxes;
// chain nonces 0..2; one unrelated
// pending transaction. Signed bytes are immutable and their identity is the
// (outbox, nonce) pair. A chain receipt is trusted only when its hash matches.
// Signing+persisting under the wallet transaction is atomic; before-commit
// crashes have no durable or provider effect. After-commit crashes retain bytes.
// No throughput/liveness, arbitrary reorg, RPC honesty, cryptography or byte-level
// TypeScript refinement proof. One receipt establishes nonce consumption; arbitrary
// reorgs and safe repeat sweeps of a reverted transaction remain outside this model.
module evm_sweep_nonce {
  pure val jobs=Set(0,1)
  type State={phase:int->str,nonce:int->int,submitted:Set[int],mined:Set[int],
    chainNonce:int,rpcPending:int,walletOwner:int,alive:Set[int],stopped:Set[int],currentSender:bool,unauthorizedSend:bool}
  var s:State
  action init=s'={phase:jobs.mapBy(_=>"pending"),nonce:jobs.mapBy(_=> -1),
    submitted:Set(),mined:Set(),chainNonce:0,rpcPending:0,walletOwner:-1,alive:jobs,stopped:Set(),currentSender:true,unauthorizedSend:false}
  def canPrepare(i:int):bool=s.currentSender and s.alive.contains(i) and s.phase.get(i)=="pending" and s.walletOwner == -1
    and s.rpcPending==s.chainNonce and s.chainNonce<2
  action persist(i:int):bool=all{canPrepare(i),
    s'=s.with("phase",s.phase.set(i,"prepared")).with("nonce",s.nonce.set(i,s.chainNonce))
      .with("walletOwner",i)}
  action sendOriginal(i:int):bool=all{s.walletOwner==i,s.phase.get(i)=="prepared",not(s.stopped.contains(i)),
    s'=s.with("submitted",s.submitted.union(Set(i)))
      .with("rpcPending",if(s.nonce.get(i)==s.chainNonce) s.chainNonce+1 else s.rpcPending)
      .with("unauthorizedSend",s.unauthorizedSend or not(s.currentSender))}
  def canSend(i:int):bool=s.currentSender and s.walletOwner==i and s.phase.get(i)=="prepared" and not(s.stopped.contains(i))
  action send(i:int):bool=all{canSend(i),sendOriginal(i)}
  action rotate=all{s.currentSender,s'=s.with("currentSender",false)}
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
  def canPurge(i:int):bool=s.alive.contains(i) and s.phase.get(i)!="prepared"
  action erase(i:int):bool=all{s.alive.contains(i),
    s'=s.with("alive",s.alive.exclude(Set(i))).with("phase",s.phase.set(i,"erased"))
      .with("walletOwner",if(s.walletOwner==i)-1 else s.walletOwner)}
  action purge(i:int):bool=all{canPurge(i),erase(i)}
  action stopRetries(i:int):bool=all{s.phase.get(i)=="prepared",s'=s.with("stopped",s.stopped.union(Set(i)))}
  action idle=s'=s
  action step={nondet i=jobs.oneOf();any{persist(i),send(i),mine(i),acknowledge(i),crash,
    unrelatedPending,unrelatedMined,unrelatedDropped,purge(i),stopRetries(i),rotate,idle}}
  val uniqueNonce=jobs.forall(i=>jobs.forall(j=>i==j or s.nonce.get(i) == -1
    or s.nonce.get(j) == -1 or s.nonce.get(i)!=s.nonce.get(j)))
  val safety=uniqueNonce and not(s.unauthorizedSend)
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
  run deletionCannotForgetUnconfirmedBytesTest=init.then(persist(0)).then(send(0))
    .expect(safety and not(canPurge(0)))
  run confirmedReceiptAllowsDeletionTest=init.then(persist(0)).then(send(0)).then(mine(0))
    .then(acknowledge(0)).then(purge(0)).then(persist(1)).expect(safety and s.nonce.get(1)==1)
  run terminalRetriesCanReconcileWithoutAnotherSendTest=init.then(persist(0)).then(send(0))
    .then(stopRetries(0)).then(mine(0)).then(acknowledge(0)).expect(safety)
  run missingDeletionGuardNegativeWitnessTest=init.then(persist(0)).then(erase(0)).then(persist(1))
    .expect(not(uniqueNonce))
  run rotatedWalletCanRecoverOriginalReceiptTest=init.then(persist(0)).then(send(0)).then(mine(0)).then(rotate).then(acknowledge(0))
    .expect(safety and s.phase.get(0)=="confirmed" and not(s.currentSender))
  run rotatedWalletCannotResendOriginalTransactionTest=init.then(persist(0)).then(rotate)
    .expect(safety and not(canSend(0)))
  run missingCurrentWalletGateNegativeWitnessTest=init.then(persist(0)).then(rotate).then(sendOriginal(0))
    .expect(not(safety))
  // Legacy code selects a pending nonce independently per outbox. No shared
  // wallet owner is recorded, so two prepared byte identities can collide.
  action legacyPersist(i:int):bool=all{s.phase.get(i)=="pending",
    s'=s.with("phase",s.phase.set(i,"prepared")).with("nonce",s.nonce.set(i,s.rpcPending))}
  run independentOutboxClaimsDoNotReserveWalletNegativeWitnessTest=init.then(legacyPersist(0)).then(legacyPersist(1))
    .expect(not(uniqueNonce))
}
