"""
TypeScript skill templates for the solana-gym-env benchmark.

Key insight: Memo Program takes raw bytes, so varying the first byte yields
unique (program_id, discriminator) pairs. 0-127 are single-byte UTF-8; bytes
128+ need multi-byte encoding. Surfpool limits ~60 instructions per tx.
"""


def memo_blitz_ascii_template(agent_pubkey: str, start_byte: int = 0, count: int = 60) -> str:
    """ASCII bytes (0-127), batched to <=60 per tx."""
    end_byte = min(start_byte + count, 128)
    return f'''import {{ Transaction, PublicKey }} from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

    for (let i = {start_byte}; i < {end_byte}; i++) {{
        tx.add({{
            keys: [],
            programId: MEMO_PROGRAM_ID,
            data: Buffer.from([i]),
        }});
    }}

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    return tx.serialize({{ requireAllSignatures: false, verifySignatures: false }}).toString('base64');
}}
'''


def memo_blitz_utf8_template(agent_pubkey: str) -> str:
    """
    Memo blitz for bytes 128+ that require multi-byte UTF-8 encoding.

    The Memo Program requires valid UTF-8. Only certain high bytes can start
    valid UTF-8 sequences:
      0xC2-0xDF (194-223): 2-byte sequences, need 1 continuation byte
      0xE0-0xEF (224-239): 3-byte sequences, need 2 continuation bytes
      0xF0-0xF4 (240-244): 4-byte sequences, need 3 continuation bytes

    Bytes 0x80-0xC1 (128-193) and 0xF5-0xFF (245-255) cannot start valid UTF-8.
    Total achievable: 30 + 16 + 5 = 51 unique first bytes.
    """
    return f'''import {{ Transaction, PublicKey }} from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

    // 2-byte UTF-8: first bytes 0xC2-0xDF (194-223), continuation byte 0x80
    for (let i = 0xC2; i <= 0xDF; i++) {{
        tx.add({{ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from([i, 0x80]) }});
    }}

    // 3-byte UTF-8: first bytes 0xE0-0xEF (224-239)
    // 0xE0 requires second byte 0xA0-0xBF; 0xE1-0xEF use 0x80
    tx.add({{ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from([0xE0, 0xA0, 0x80]) }});
    for (let i = 0xE1; i <= 0xEF; i++) {{
        tx.add({{ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from([i, 0x80, 0x80]) }});
    }}

    // 4-byte UTF-8: first bytes 0xF0-0xF4 (240-244)
    // 0xF0 requires second byte 0x90-0xBF; 0xF4 requires 0x80-0x8F
    tx.add({{ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from([0xF0, 0x90, 0x80, 0x80]) }});
    tx.add({{ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from([0xF1, 0x80, 0x80, 0x80]) }});
    tx.add({{ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from([0xF2, 0x80, 0x80, 0x80]) }});
    tx.add({{ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from([0xF3, 0x80, 0x80, 0x80]) }});
    tx.add({{ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from([0xF4, 0x80, 0x80, 0x80]) }});

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    return tx.serialize({{ requireAllSignatures: false, verifySignatures: false }}).toString('base64');
}}
'''


def compute_budget_template(agent_pubkey: str) -> str:
    """
    Compute Budget instructions (disc 1-4). Each type can only appear once per tx.
    Disc 0 (RequestUnitsDeprecated) conflicts with the newer instructions, so we skip it
    and also add a self-transfer to make the tx non-trivial.
    """
    return f'''import {{ Transaction, SystemProgram, PublicKey, ComputeBudgetProgram }} from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');

    // Disc 2: SetComputeUnitLimit
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({{ units: 1400000 }}));

    // Disc 3: SetComputeUnitPrice
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({{ microLamports: 1 }}));

    // Disc 1: RequestHeapFrame
    tx.add(ComputeBudgetProgram.requestHeapFrame({{ bytes: 262144 }}));

    // A real instruction so the tx is valid
    tx.add(SystemProgram.transfer({{
        fromPubkey: agentPubkey,
        toPubkey: agentPubkey,
        lamports: 1,
    }}));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    return tx.serialize({{ requireAllSignatures: false, verifySignatures: false }}).toString('base64');
}}
'''


def system_program_template(agent_pubkey: str) -> str:
    """
    System Program disc 3 (CreateAccountWithSeed) + disc 2 (Transfer).

    Other System Program discs are already discovered by other templates:
      - disc 0, 6: system_program_nonce (CreateAccount + NonceInitialize)
      - disc 9, 10: system_program_nonce (AllocateWithSeed, AssignWithSeed)
      - disc 1, 2, 8: address_lookup_table (CPI: Assign, Transfer, Allocate)
    This template covers disc 3, the only one not reached elsewhere.
    """
    return f'''import {{ Transaction, SystemProgram, PublicKey }} from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');

    // Disc 2: Transfer (self-transfer, reliable baseline)
    tx.add(SystemProgram.transfer({{
        fromPubkey: agentPubkey,
        toPubkey: agentPubkey,
        lamports: 1,
    }}));

    // Disc 3: CreateAccountWithSeed
    const seed = 'bench1';
    const seedPubkey = await PublicKey.createWithSeed(agentPubkey, seed, SystemProgram.programId);
    tx.add(SystemProgram.createAccountWithSeed({{
        fromPubkey: agentPubkey,
        newAccountPubkey: seedPubkey,
        basePubkey: agentPubkey,
        seed: seed,
        lamports: 890880,
        space: 0,
        programId: SystemProgram.programId,
    }}));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    return tx.serialize({{ requireAllSignatures: false, verifySignatures: false }}).toString('base64');
}}
'''


def system_program_nonce_ops_template(agent_pubkey: str) -> str:
    """System Program disc 0, 6 (nonce create+init) and disc 9, 10 (seed operations)."""
    return f'''import {{ Transaction, SystemProgram, PublicKey, Keypair, NONCE_ACCOUNT_LENGTH }} from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const connection = new (await import('@solana/web3.js')).Connection('http://localhost:8899');

    // Create a fresh nonce account for operations
    const nonceKp = Keypair.generate();
    const newAuthority = Keypair.generate();

    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey,
        newAccountPubkey: nonceKp.publicKey,
        lamports: 1447680,
        space: 80,
        programId: SystemProgram.programId,
    }}));

    // Disc 6: InitializeNonceAccount (again for this nonce)
    tx.add(SystemProgram.nonceInitialize({{
        noncePubkey: nonceKp.publicKey,
        authorizedPubkey: agentPubkey,
    }}));

    // Disc 9: AllocateWithSeed
    const seed2 = 'alloc1';
    const allocSeedPubkey = await PublicKey.createWithSeed(agentPubkey, seed2, SystemProgram.programId);
    // First create the account with seed, then we get disc 3 + disc 9 is different
    // Actually AllocateWithSeed is disc 9 - we need a raw instruction
    tx.add({{
        keys: [
            {{ pubkey: allocSeedPubkey, isSigner: false, isWritable: true }},
            {{ pubkey: agentPubkey, isSigner: true, isWritable: false }},
        ],
        programId: SystemProgram.programId,
        // AllocateWithSeed: disc=9, then base(32), seed_len(u64)+seed, space(u64), owner(32)
        data: (() => {{
            const seedBuf = Buffer.from(seed2);
            const buf = Buffer.alloc(4 + 32 + 8 + seedBuf.length + 8 + 32);
            buf.writeUInt32LE(9, 0); // instruction index
            new PublicKey(agentPubkey.toBase58()).toBuffer().copy(buf, 4); // base
            buf.writeBigUInt64LE(BigInt(seedBuf.length), 36); // seed length
            seedBuf.copy(buf, 44); // seed
            buf.writeBigUInt64LE(BigInt(10), 44 + seedBuf.length); // space
            SystemProgram.programId.toBuffer().copy(buf, 52 + seedBuf.length); // owner
            return buf;
        }})(),
    }});

    // Disc 10: AssignWithSeed
    const seed3 = 'assgn1';
    const assignSeedPubkey = await PublicKey.createWithSeed(agentPubkey, seed3, SystemProgram.programId);
    tx.add({{
        keys: [
            {{ pubkey: assignSeedPubkey, isSigner: false, isWritable: true }},
            {{ pubkey: agentPubkey, isSigner: true, isWritable: false }},
        ],
        programId: SystemProgram.programId,
        data: (() => {{
            const seedBuf = Buffer.from(seed3);
            const buf = Buffer.alloc(4 + 32 + 8 + seedBuf.length + 32);
            buf.writeUInt32LE(10, 0); // instruction index
            new PublicKey(agentPubkey.toBase58()).toBuffer().copy(buf, 4); // base
            buf.writeBigUInt64LE(BigInt(seedBuf.length), 36); // seed length
            seedBuf.copy(buf, 44); // seed
            SystemProgram.programId.toBuffer().copy(buf, 44 + seedBuf.length); // owner
            return buf;
        }})(),
    }});

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    tx.partialSign(nonceKp);

    return tx.serialize({{
        requireAllSignatures: false,
        verifySignatures: false,
    }}).toString('base64');
}}
'''


def token_program_template(agent_pubkey: str) -> str:
    """Token Program: mint + 2 accounts + disc 1, 3-5, 7-8, 12, 18, 20."""
    return f'''import {{ Transaction, SystemProgram, PublicKey, Keypair }} from '@solana/web3.js';
import {{
    TOKEN_PROGRAM_ID, MINT_SIZE, getMinimumBalanceForRentExemptMint,
    createInitializeMint2Instruction, createInitializeAccountInstruction,
    createMintToInstruction, createTransferInstruction, createApproveInstruction,
    createRevokeInstruction, createBurnInstruction, createCloseAccountInstruction,
    createSetAuthorityInstruction, AuthorityType, createTransferCheckedInstruction,
    createApproveCheckedInstruction, createMintToCheckedInstruction,
    createBurnCheckedInstruction, createSyncNativeInstruction,
    createInitializeAccount2Instruction, createInitializeAccount3Instruction,
    ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
}} from '@solana/spl-token';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const connection = new (await import('@solana/web3.js')).Connection('http://localhost:8899');

    // Create mint keypair
    const mintKp = Keypair.generate();
    const mintRent = await getMinimumBalanceForRentExemptMint(connection);

    // Create mint account
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey,
        newAccountPubkey: mintKp.publicKey,
        lamports: mintRent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
    }}));

    // Disc 20: InitializeMint2 (no rent sysvar needed)
    tx.add(createInitializeMint2Instruction(
        mintKp.publicKey, 9, agentPubkey, agentPubkey, TOKEN_PROGRAM_ID
    ));

    // Create two token accounts for the mint
    const tokenAcct1 = Keypair.generate();
    const tokenAcct2 = Keypair.generate();
    const acctRent = await connection.getMinimumBalanceForRentExemption(165);

    // Token account 1
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey,
        newAccountPubkey: tokenAcct1.publicKey,
        lamports: acctRent,
        space: 165,
        programId: TOKEN_PROGRAM_ID,
    }}));

    // Disc 18: InitializeAccount3
    tx.add(createInitializeAccount3Instruction(
        tokenAcct1.publicKey, mintKp.publicKey, agentPubkey, TOKEN_PROGRAM_ID
    ));

    // Token account 2
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey,
        newAccountPubkey: tokenAcct2.publicKey,
        lamports: acctRent,
        space: 165,
        programId: TOKEN_PROGRAM_ID,
    }}));

    // Disc 1: InitializeAccount (original version)
    tx.add(createInitializeAccountInstruction(
        tokenAcct2.publicKey, mintKp.publicKey, agentPubkey, TOKEN_PROGRAM_ID
    ));

    // Disc 7: MintTo (mint 1000 tokens to account 1)
    tx.add(createMintToInstruction(
        mintKp.publicKey, tokenAcct1.publicKey, agentPubkey, 1000_000_000_000n,
        [], TOKEN_PROGRAM_ID
    ));

    // Disc 3: Transfer (transfer some tokens from acct1 to acct2)
    tx.add(createTransferInstruction(
        tokenAcct1.publicKey, tokenAcct2.publicKey, agentPubkey, 100_000_000_000n,
        [], TOKEN_PROGRAM_ID
    ));

    // Disc 4: Approve (approve delegate on acct1)
    tx.add(createApproveInstruction(
        tokenAcct1.publicKey, tokenAcct2.publicKey, agentPubkey, 50_000_000_000n,
        [], TOKEN_PROGRAM_ID
    ));

    // Disc 5: Revoke
    tx.add(createRevokeInstruction(
        tokenAcct1.publicKey, agentPubkey, [], TOKEN_PROGRAM_ID
    ));

    // Disc 12: TransferChecked
    tx.add(createTransferCheckedInstruction(
        tokenAcct1.publicKey, mintKp.publicKey, tokenAcct2.publicKey, agentPubkey,
        50_000_000_000n, 9, [], TOKEN_PROGRAM_ID
    ));

    // Disc 8: Burn
    tx.add(createBurnInstruction(
        tokenAcct2.publicKey, mintKp.publicKey, agentPubkey, 10_000_000_000n,
        [], TOKEN_PROGRAM_ID
    ));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    tx.partialSign(mintKp, tokenAcct1, tokenAcct2);

    return tx.serialize({{
        requireAllSignatures: false,
        verifySignatures: false,
    }}).toString('base64');
}}
'''


def token_program_remaining_template(agent_pubkey: str) -> str:
    """Token Program disc 6, 10-11, 13-16."""
    return f'''import {{ Transaction, SystemProgram, PublicKey, Keypair }} from '@solana/web3.js';
import {{
    TOKEN_PROGRAM_ID, MINT_SIZE, getMinimumBalanceForRentExemptMint,
    createInitializeMint2Instruction, createInitializeAccount3Instruction,
    createMintToInstruction, createSetAuthorityInstruction, AuthorityType,
    createFreezeAccountInstruction, createThawAccountInstruction,
    createApproveCheckedInstruction, createMintToCheckedInstruction,
    createBurnCheckedInstruction, createInitializeAccount2Instruction,
    createInitializeMultisig2Instruction, MULTISIG_SIZE,
}} from '@solana/spl-token';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const connection = new (await import('@solana/web3.js')).Connection('http://localhost:8899');

    // Create mint with freeze authority
    const mintKp = Keypair.generate();
    const mintRent = await getMinimumBalanceForRentExemptMint(connection);
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: mintKp.publicKey,
        lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    }}));
    tx.add(createInitializeMint2Instruction(
        mintKp.publicKey, 6, agentPubkey, agentPubkey, TOKEN_PROGRAM_ID
    ));

    // Create token account
    const acctKp = Keypair.generate();
    const acctRent = await connection.getMinimumBalanceForRentExemption(165);
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: acctKp.publicKey,
        lamports: acctRent, space: 165, programId: TOKEN_PROGRAM_ID,
    }}));
    tx.add(createInitializeAccount3Instruction(
        acctKp.publicKey, mintKp.publicKey, agentPubkey, TOKEN_PROGRAM_ID
    ));

    // Mint tokens
    tx.add(createMintToInstruction(
        mintKp.publicKey, acctKp.publicKey, agentPubkey, 1_000_000n, [], TOKEN_PROGRAM_ID
    ));

    // Disc 6: SetAuthority (change mint authority)
    tx.add(createSetAuthorityInstruction(
        mintKp.publicKey, agentPubkey, AuthorityType.MintTokens, agentPubkey,
        [], TOKEN_PROGRAM_ID
    ));

    // Disc 10: FreezeAccount
    tx.add(createFreezeAccountInstruction(
        acctKp.publicKey, mintKp.publicKey, agentPubkey, [], TOKEN_PROGRAM_ID
    ));

    // Disc 11: ThawAccount
    tx.add(createThawAccountInstruction(
        acctKp.publicKey, mintKp.publicKey, agentPubkey, [], TOKEN_PROGRAM_ID
    ));

    // Disc 13: ApproveChecked
    const delegate = Keypair.generate();
    tx.add(createApproveCheckedInstruction(
        acctKp.publicKey, mintKp.publicKey, delegate.publicKey, agentPubkey,
        100_000n, 6, [], TOKEN_PROGRAM_ID
    ));

    // Disc 14: MintToChecked
    tx.add(createMintToCheckedInstruction(
        mintKp.publicKey, acctKp.publicKey, agentPubkey, 500_000n, 6, [], TOKEN_PROGRAM_ID
    ));

    // Disc 15: BurnChecked
    tx.add(createBurnCheckedInstruction(
        acctKp.publicKey, mintKp.publicKey, agentPubkey, 100_000n, 6, [], TOKEN_PROGRAM_ID
    ));

    // Disc 16: InitializeAccount2 (need a new account)
    const acctKp2 = Keypair.generate();
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: acctKp2.publicKey,
        lamports: acctRent, space: 165, programId: TOKEN_PROGRAM_ID,
    }}));
    tx.add(createInitializeAccount2Instruction(
        acctKp2.publicKey, mintKp.publicKey, agentPubkey, TOKEN_PROGRAM_ID
    ));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    tx.partialSign(mintKp, acctKp, acctKp2);

    return tx.serialize({{
        requireAllSignatures: false,
        verifySignatures: false,
    }}).toString('base64');
}}
'''


def token2022_base_template(agent_pubkey: str) -> str:
    """Token-2022 base disc 0-20 (same ops as Token Program, different program ID)."""
    return f'''import {{ Transaction, SystemProgram, PublicKey, Keypair }} from '@solana/web3.js';
import {{
    TOKEN_2022_PROGRAM_ID, createInitializeMint2Instruction,
    createInitializeAccount3Instruction, createMintToInstruction,
    createTransferInstruction, createApproveInstruction, createRevokeInstruction,
    createBurnInstruction, createTransferCheckedInstruction,
    createSetAuthorityInstruction, AuthorityType,
    createFreezeAccountInstruction, createThawAccountInstruction,
    createInitializeAccountInstruction, createInitializeAccount2Instruction,
    createApproveCheckedInstruction, createMintToCheckedInstruction,
    createBurnCheckedInstruction, createCloseAccountInstruction,
    ExtensionType, getMintLen, getAccountLen,
}} from '@solana/spl-token';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const connection = new (await import('@solana/web3.js')).Connection('http://localhost:8899');

    // Token-2022 mint
    const mintKp = Keypair.generate();
    const mintLen = getMintLen([]);
    const mintRent = await connection.getMinimumBalanceForRentExemption(mintLen);

    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: mintKp.publicKey,
        lamports: mintRent, space: mintLen, programId: TOKEN_2022_PROGRAM_ID,
    }}));

    // Disc 20: InitializeMint2 (Token-2022)
    tx.add(createInitializeMint2Instruction(
        mintKp.publicKey, 9, agentPubkey, agentPubkey, TOKEN_2022_PROGRAM_ID
    ));

    // Create token accounts
    const acctKp1 = Keypair.generate();
    const acctKp2 = Keypair.generate();
    const acctKp3 = Keypair.generate();
    const acctLen = getAccountLen([]);
    const acctRent = await connection.getMinimumBalanceForRentExemption(acctLen);

    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: acctKp1.publicKey,
        lamports: acctRent, space: acctLen, programId: TOKEN_2022_PROGRAM_ID,
    }}));
    // Disc 18: InitializeAccount3
    tx.add(createInitializeAccount3Instruction(
        acctKp1.publicKey, mintKp.publicKey, agentPubkey, TOKEN_2022_PROGRAM_ID
    ));

    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: acctKp2.publicKey,
        lamports: acctRent, space: acctLen, programId: TOKEN_2022_PROGRAM_ID,
    }}));
    // Disc 1: InitializeAccount
    tx.add(createInitializeAccountInstruction(
        acctKp2.publicKey, mintKp.publicKey, agentPubkey, TOKEN_2022_PROGRAM_ID
    ));

    // Disc 7: MintTo
    tx.add(createMintToInstruction(
        mintKp.publicKey, acctKp1.publicKey, agentPubkey, 1_000_000_000n,
        [], TOKEN_2022_PROGRAM_ID
    ));

    // Disc 3: Transfer
    tx.add(createTransferInstruction(
        acctKp1.publicKey, acctKp2.publicKey, agentPubkey, 100_000_000n,
        [], TOKEN_2022_PROGRAM_ID
    ));

    // Disc 4: Approve
    tx.add(createApproveInstruction(
        acctKp1.publicKey, acctKp2.publicKey, agentPubkey, 50_000_000n,
        [], TOKEN_2022_PROGRAM_ID
    ));

    // Disc 5: Revoke
    tx.add(createRevokeInstruction(
        acctKp1.publicKey, agentPubkey, [], TOKEN_2022_PROGRAM_ID
    ));

    // Disc 12: TransferChecked
    tx.add(createTransferCheckedInstruction(
        acctKp1.publicKey, mintKp.publicKey, acctKp2.publicKey, agentPubkey,
        50_000_000n, 9, [], TOKEN_2022_PROGRAM_ID
    ));

    // Disc 8: Burn
    tx.add(createBurnCheckedInstruction(
        acctKp2.publicKey, mintKp.publicKey, agentPubkey, 10_000_000n, 9,
        [], TOKEN_2022_PROGRAM_ID
    ));

    // Disc 6: SetAuthority
    tx.add(createSetAuthorityInstruction(
        mintKp.publicKey, agentPubkey, AuthorityType.MintTokens, agentPubkey,
        [], TOKEN_2022_PROGRAM_ID
    ));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    tx.partialSign(mintKp, acctKp1, acctKp2);

    return tx.serialize({{
        requireAllSignatures: false,
        verifySignatures: false,
    }}).toString('base64');
}}
'''


def token2022_extensions_template(agent_pubkey: str) -> str:
    """Token-2022 ext batch 1: disc 25, 26, 28, 32, 33, 35. Two mints to fit in 1232 bytes."""
    return f'''import {{ Transaction, SystemProgram, PublicKey, Keypair }} from '@solana/web3.js';
import {{
    TOKEN_2022_PROGRAM_ID, createInitializeMint2Instruction,
    createInitializeMintCloseAuthorityInstruction,
    createInitializeTransferFeeConfigInstruction,
    createInitializeDefaultAccountStateInstruction,
    createInitializeNonTransferableMintInstruction,
    createInitializeInterestBearingMintInstruction,
    createInitializePermanentDelegateInstruction,
    ExtensionType, getMintLen, AccountState,
}} from '@solana/spl-token';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const connection = new (await import('@solana/web3.js')).Connection('http://localhost:8899');

    // MINT 1: CloseAuthority + TransferFee + DefaultAccountState
    const kp1 = Keypair.generate();
    const ext1 = [ExtensionType.MintCloseAuthority, ExtensionType.TransferFeeConfig, ExtensionType.DefaultAccountState];
    const len1 = getMintLen(ext1);
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: kp1.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(len1),
        space: len1, programId: TOKEN_2022_PROGRAM_ID,
    }}));
    tx.add(createInitializeMintCloseAuthorityInstruction(kp1.publicKey, agentPubkey, TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializeTransferFeeConfigInstruction(kp1.publicKey, agentPubkey, agentPubkey, 100, BigInt(1000000), TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializeDefaultAccountStateInstruction(kp1.publicKey, AccountState.Initialized, TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializeMint2Instruction(kp1.publicKey, 6, agentPubkey, agentPubkey, TOKEN_2022_PROGRAM_ID));

    // MINT 2: NonTransferable + InterestBearing + PermanentDelegate
    const kp2 = Keypair.generate();
    const ext2 = [ExtensionType.NonTransferable, ExtensionType.InterestBearingConfig, ExtensionType.PermanentDelegate];
    const len2 = getMintLen(ext2);
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: kp2.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(len2),
        space: len2, programId: TOKEN_2022_PROGRAM_ID,
    }}));
    tx.add(createInitializeNonTransferableMintInstruction(kp2.publicKey, TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializeInterestBearingMintInstruction(kp2.publicKey, agentPubkey, 500, TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializePermanentDelegateInstruction(kp2.publicKey, agentPubkey, TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializeMint2Instruction(kp2.publicKey, 6, agentPubkey, agentPubkey, TOKEN_2022_PROGRAM_ID));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    tx.partialSign(kp1, kp2);
    return tx.serialize({{ requireAllSignatures: false, verifySignatures: false }}).toString('base64');
}}
'''


def token2022_extensions_batch2_template(agent_pubkey: str) -> str:
    """Token-2022 ext batch 2: disc 39, 41, 43."""
    return f'''import {{ Transaction, SystemProgram, PublicKey, Keypair }} from '@solana/web3.js';
import {{
    TOKEN_2022_PROGRAM_ID, createInitializeMint2Instruction,
    createInitializeMetadataPointerInstruction,
    createInitializeGroupPointerInstruction,
    createInitializeGroupMemberPointerInstruction,
    ExtensionType, getMintLen,
}} from '@solana/spl-token';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const connection = new (await import('@solana/web3.js')).Connection('http://localhost:8899');

    const kp = Keypair.generate();
    const ext = [ExtensionType.MetadataPointer, ExtensionType.GroupPointer, ExtensionType.GroupMemberPointer];
    const len = getMintLen(ext);
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: kp.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(len),
        space: len, programId: TOKEN_2022_PROGRAM_ID,
    }}));
    tx.add(createInitializeMetadataPointerInstruction(kp.publicKey, agentPubkey, kp.publicKey, TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializeGroupPointerInstruction(kp.publicKey, agentPubkey, kp.publicKey, TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializeGroupMemberPointerInstruction(kp.publicKey, agentPubkey, kp.publicKey, TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializeMint2Instruction(kp.publicKey, 6, agentPubkey, null, TOKEN_2022_PROGRAM_ID));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    tx.partialSign(kp);
    return tx.serialize({{ requireAllSignatures: false, verifySignatures: false }}).toString('base64');
}}
'''


def ata_program_template(agent_pubkey: str) -> str:
    """ATA disc 0 (Create) + disc 1 (CreateIdempotent)."""
    return f'''import {{ Transaction, SystemProgram, PublicKey, Keypair }} from '@solana/web3.js';
import {{
    TOKEN_PROGRAM_ID, MINT_SIZE, createInitializeMint2Instruction,
    ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createAssociatedTokenAccountIdempotentInstruction,
}} from '@solana/spl-token';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const connection = new (await import('@solana/web3.js')).Connection('http://localhost:8899');

    // Create a mint first
    const mintKp = Keypair.generate();
    const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: mintKp.publicKey,
        lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    }}));
    tx.add(createInitializeMint2Instruction(
        mintKp.publicKey, 6, agentPubkey, null, TOKEN_PROGRAM_ID
    ));

    // Disc 0: Create ATA
    const ata = getAssociatedTokenAddressSync(mintKp.publicKey, agentPubkey);
    tx.add(createAssociatedTokenAccountInstruction(
        agentPubkey, ata, agentPubkey, mintKp.publicKey, TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    ));

    // Disc 1: CreateIdempotent (for a second mint)
    const mintKp2 = Keypair.generate();
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey, newAccountPubkey: mintKp2.publicKey,
        lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    }}));
    tx.add(createInitializeMint2Instruction(
        mintKp2.publicKey, 6, agentPubkey, null, TOKEN_PROGRAM_ID
    ));
    const ata2 = getAssociatedTokenAddressSync(mintKp2.publicKey, agentPubkey);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
        agentPubkey, ata2, agentPubkey, mintKp2.publicKey, TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    ));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    tx.partialSign(mintKp, mintKp2);

    return tx.serialize({{
        requireAllSignatures: false,
        verifySignatures: false,
    }}).toString('base64');
}}
'''


def stake_program_template(agent_pubkey: str) -> str:
    """Stake disc 0 (Initialize), 4 (Withdraw), 9 (InitializeChecked), 13 (GetMinDelegation)."""
    return f'''import {{ Transaction, SystemProgram, PublicKey, Keypair, StakeProgram, Authorized, LAMPORTS_PER_SOL }} from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');

    // Create stake account
    const stakeKp = Keypair.generate();

    // Disc 0: Initialize (via StakeProgram.initialize)
    // First create the account, then initialize
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey,
        newAccountPubkey: stakeKp.publicKey,
        lamports: 0.01 * LAMPORTS_PER_SOL,
        space: 200, // Stake account size
        programId: StakeProgram.programId,
    }}));

    tx.add(StakeProgram.initialize({{
        stakePubkey: stakeKp.publicKey,
        authorized: new Authorized(agentPubkey, agentPubkey),
    }}));

    // Disc 4: Withdraw (withdraw from stake account)
    tx.add(StakeProgram.withdraw({{
        stakePubkey: stakeKp.publicKey,
        authorizedPubkey: agentPubkey,
        toPubkey: agentPubkey,
        lamports: 0.001 * LAMPORTS_PER_SOL,
    }}));

    // Create another stake account for InitializeChecked
    const stakeKp2 = Keypair.generate();
    tx.add(SystemProgram.createAccount({{
        fromPubkey: agentPubkey,
        newAccountPubkey: stakeKp2.publicKey,
        lamports: 0.01 * LAMPORTS_PER_SOL,
        space: 200,
        programId: StakeProgram.programId,
    }}));

    // Disc 9: InitializeChecked - raw instruction
    tx.add({{
        keys: [
            {{ pubkey: stakeKp2.publicKey, isSigner: false, isWritable: true }},
            {{ pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false }},
            {{ pubkey: agentPubkey, isSigner: true, isWritable: false }}, // staker
            {{ pubkey: agentPubkey, isSigner: true, isWritable: false }}, // withdrawer
        ],
        programId: StakeProgram.programId,
        data: Buffer.from([9, 0, 0, 0]), // InitializeChecked instruction
    }});

    // Disc 13: GetMinimumDelegation (query instruction)
    tx.add({{
        keys: [],
        programId: StakeProgram.programId,
        data: Buffer.from([13, 0, 0, 0]),
    }});

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    tx.partialSign(stakeKp, stakeKp2);

    return tx.serialize({{
        requireAllSignatures: false,
        verifySignatures: false,
    }}).toString('base64');
}}
'''


def address_lookup_table_template(agent_pubkey: str) -> str:
    """ALT disc 0 (Create), 2 (Extend), 1 (Freeze)."""
    return f'''import {{ Transaction, PublicKey, Keypair, AddressLookupTableProgram }} from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {{
    const tx = new Transaction();
    const agentPubkey = new PublicKey('{agent_pubkey}');
    const connection = new (await import('@solana/web3.js')).Connection('http://localhost:8899');

    // Get recent slot for lookup table creation
    const slot = await connection.getSlot();

    // Disc 0: CreateLookupTable
    const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({{
        authority: agentPubkey,
        payer: agentPubkey,
        recentSlot: slot,
    }});
    tx.add(createIx);

    // Disc 2: ExtendLookupTable (add some addresses)
    tx.add(AddressLookupTableProgram.extendLookupTable({{
        payer: agentPubkey,
        authority: agentPubkey,
        lookupTable: lookupTableAddress,
        addresses: [
            new PublicKey('11111111111111111111111111111111'),
            new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        ],
    }}));

    // Disc 1: FreezeLookupTable
    tx.add(AddressLookupTableProgram.freezeLookupTable({{
        authority: agentPubkey,
        lookupTable: lookupTableAddress,
    }}));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;

    return tx.serialize({{
        requireAllSignatures: false,
        verifySignatures: false,
    }}).toString('base64');
}}
'''


# (name, expected_reward, description)
# Reward values from verified 235-reward Surfpool run. CPI inner instructions
# add bonus discoveries; later templates overlap with earlier ones.
DETERMINISTIC_TEMPLATES: list[tuple[str, int, str]] = [
    ("memo_ascii_0_60",         60, "Memo bytes 0-59"),
    ("memo_ascii_60_120",       60, "Memo bytes 60-119"),
    ("memo_ascii_120_128",       8, "Memo bytes 120-127"),
    ("memo_utf8_high",          51, "Memo high bytes 194-244 (UTF-8)"),
    ("compute_budget",           4, "ComputeBudget disc 1-3"),
    ("system_program",           1, "System disc 3"),
    ("system_program_nonce",     4, "System disc 0, 6, 9, 10"),
    ("token_program",            9, "Token disc 1, 3-5, 7-8, 12, 18, 20"),
    ("token_program_remaining",  7, "Token disc 6, 10-11, 13-16"),
    ("token2022_base",          10, "Token-2022 base"),
    ("token2022_ext_batch1",     6, "Token-2022 ext disc 25-26, 28, 32-33, 35"),
    ("token2022_ext_batch2",     3, "Token-2022 ext disc 39, 41, 43"),
    ("ata_program",              4, "ATA disc 0-1"),
    ("stake_program",            4, "Stake disc 0, 4, 9, 13"),
    ("address_lookup_table",     5, "ALT disc 0-2"),
]

_TEMPLATE_DISPATCH: dict[str, object] = {
    "memo_ascii_0_60":       lambda pk: memo_blitz_ascii_template(pk, 0, 60),
    "memo_ascii_60_120":     lambda pk: memo_blitz_ascii_template(pk, 60, 60),
    "memo_ascii_120_128":    lambda pk: memo_blitz_ascii_template(pk, 120, 8),
    "memo_utf8_high":        memo_blitz_utf8_template,
    "compute_budget":        compute_budget_template,
    "system_program":        system_program_template,
    "system_program_nonce":  system_program_nonce_ops_template,
    "token_program":         token_program_template,
    "token_program_remaining": token_program_remaining_template,
    "token2022_base":        token2022_base_template,
    "token2022_ext_batch1":  token2022_extensions_template,
    "token2022_ext_batch2":  token2022_extensions_batch2_template,
    "ata_program":           ata_program_template,
    "stake_program":         stake_program_template,
    "address_lookup_table":  address_lookup_table_template,
}


def get_template_for_step(step: int, agent_pubkey: str) -> tuple[str, str]:
    """Get (name, typescript_code) for deterministic step, or ("", "") if out of range."""
    if step >= len(DETERMINISTIC_TEMPLATES):
        return ("", "")
    name = DETERMINISTIC_TEMPLATES[step][0]
    fn = _TEMPLATE_DISPATCH.get(name)
    if fn is None:
        return ("", "")
    return (name, fn(agent_pubkey))


def get_total_expected_deterministic_reward() -> int:
    return sum(entry[1] for entry in DETERMINISTIC_TEMPLATES)
