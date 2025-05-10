/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/raydium_vault.json`.
 */
export type RaydiumVault = {
  address: 'autoFENwXX1Y3V4pkUdJw7WzhF1ZT6xQsyJWkLqBcta';
  metadata: {
    name: 'raydiumVault';
    version: '0.1.0';
    spec: '0.1.0';
    description: 'Created with Anchor';
  };
  docs: [
    '* Raydium CLMM\n * devnet: devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH\n * mainnet: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ];
  instructions: [
    {
      name: 'changeClaimer';
      discriminator: [89, 180, 248, 121, 12, 93, 126, 137];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'vaultConfig';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'userPosition';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                ];
              },
              {
                kind: 'account';
                path: 'positionNft';
              },
            ];
          };
        },
        {
          name: 'positionNft';
        },
      ];
      args: [
        {
          name: 'newClaimer';
          type: 'pubkey';
        },
      ];
    },
    {
      name: 'changeEmergencyAuthority';
      discriminator: [14, 23, 238, 255, 180, 142, 114, 8];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'vaultConfig';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
      ];
      args: [
        {
          name: 'newEmergency';
          type: 'pubkey';
        },
      ];
    },
    {
      name: 'changeExecutorAuthority';
      discriminator: [158, 112, 196, 228, 59, 224, 185, 41];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'vaultConfig';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
      ];
      args: [
        {
          name: 'newExecutor';
          type: 'pubkey';
        },
      ];
    },
    {
      name: 'changeManagerAuthority';
      discriminator: [60, 237, 137, 28, 46, 142, 255, 123];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'vaultConfig';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
      ];
      args: [
        {
          name: 'newManager';
          type: 'pubkey';
        },
      ];
    },
    {
      name: 'claim';
      discriminator: [62, 198, 214, 193, 213, 159, 108, 210];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'vaultConfig';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'userPosition';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                ];
              },
              {
                kind: 'account';
                path: 'locked_liquidity.fee_nft_mint';
                account: 'lockedCpLiquidityState';
              },
            ];
          };
        },
        {
          name: 'lockingProgram';
          address: 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE';
        },
        {
          name: 'lockedAuthority';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  108,
                  111,
                  99,
                  107,
                  95,
                  99,
                  112,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121,
                  95,
                  115,
                  101,
                  101,
                  100,
                ];
              },
            ];
            program: {
              kind: 'account';
              path: 'lockingProgram';
            };
          };
        },
        {
          name: 'feeNftOwner';
          docs: ['Fee nft owner who is allowed to receive fees'];
        },
        {
          name: 'feeNftAccount';
          docs: ['Fee token account'];
        },
        {
          name: 'lockedLiquidity';
          docs: ['Store the locked the information of liquidity'];
          writable: true;
        },
        {
          name: 'cpmmProgram';
          docs: ['cpmm program'];
          address: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
        },
        {
          name: 'cpAuthority';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  110,
                  100,
                  95,
                  108,
                  112,
                  95,
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  95,
                  115,
                  101,
                  101,
                  100,
                ];
              },
            ];
            program: {
              kind: 'account';
              path: 'cpmmProgram';
            };
          };
        },
        {
          name: 'poolState';
          writable: true;
        },
        {
          name: 'lpMint';
          docs: ['The mint of liquidity token', 'address = pool_state.lp_mint'];
          writable: true;
        },
        {
          name: 'recipientToken0Account';
          docs: ['The token account for receive token_0'];
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'user_position.claimer';
                account: 'userPosition';
              },
              {
                kind: 'const';
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169,
                ];
              },
              {
                kind: 'account';
                path: 'token_0_vault.mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'recipientToken1Account';
          docs: ['The token account for receive token_1'];
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'user_position.claimer';
                account: 'userPosition';
              },
              {
                kind: 'const';
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169,
                ];
              },
              {
                kind: 'account';
                path: 'token_1_vault.mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'token0Vault';
          docs: [
            'The address that holds pool tokens for token_0',
            'address = pool_state.token_0_vault',
          ];
          writable: true;
        },
        {
          name: 'token1Vault';
          docs: [
            'The address that holds pool tokens for token_1',
            'address = pool_state.token_1_vault',
          ];
          writable: true;
        },
        {
          name: 'vault0Mint';
          docs: ['The mint of token_0 vault'];
        },
        {
          name: 'vault1Mint';
          docs: ['The mint of token_1 vault'];
        },
        {
          name: 'lockedLpVault';
          docs: ['locked lp token account'];
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'lockedAuthority';
              },
              {
                kind: 'const';
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169,
                ];
              },
              {
                kind: 'account';
                path: 'lpMint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'tokenProgram';
          docs: ['token Program'];
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        },
        {
          name: 'tokenProgram2022';
          docs: ['Token program 2022'];
          address: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
        },
        {
          name: 'memoProgram';
          docs: ['memo program'];
          address: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
        },
      ];
      args: [];
    },
    {
      name: 'deposit';
      discriminator: [242, 35, 198, 137, 82, 225, 242, 182];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'vaultConfig';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'userPosition';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                ];
              },
              {
                kind: 'account';
                path: 'positionNft';
              },
            ];
          };
        },
        {
          name: 'positionNft';
        },
        {
          name: 'fromAccount';
          writable: true;
        },
        {
          name: 'nftTokenFaucet';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  110,
                  102,
                  116,
                  95,
                  115,
                  101,
                  101,
                  100,
                ];
              },
              {
                kind: 'account';
                path: 'positionNft';
              },
            ];
          };
        },
        {
          name: 'tokenProgram';
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'claimerAddress';
          type: 'pubkey';
        },
      ];
    },
    {
      name: 'emergencyWithdraw';
      discriminator: [239, 45, 203, 64, 150, 73, 218, 92];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'vaultConfig';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'userPosition';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                ];
              },
              {
                kind: 'account';
                path: 'positionNft';
              },
            ];
          };
        },
        {
          name: 'positionNft';
          writable: true;
        },
        {
          name: 'nftTokenFaucet';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  110,
                  102,
                  116,
                  95,
                  115,
                  101,
                  101,
                  100,
                ];
              },
              {
                kind: 'account';
                path: 'positionNft';
              },
            ];
          };
        },
        {
          name: 'toAccount';
          writable: true;
        },
        {
          name: 'tokenProgram';
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        },
      ];
      args: [];
    },
    {
      name: 'initialize';
      discriminator: [175, 175, 109, 31, 13, 152, 155, 237];
      accounts: [
        {
          name: 'payer';
          writable: true;
          signer: true;
        },
        {
          name: 'vaultConfig';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'systemProgram';
          docs: ['System program'];
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'initConfig';
          type: {
            defined: {
              name: 'initVaultConfig';
            };
          };
        },
      ];
    },
  ];
  accounts: [
    {
      name: 'lockedCpLiquidityState';
      discriminator: [25, 10, 238, 197, 207, 234, 73, 22];
    },
    {
      name: 'userPosition';
      discriminator: [251, 248, 209, 245, 83, 234, 17, 27];
    },
    {
      name: 'vaultConfig';
      discriminator: [99, 86, 43, 216, 184, 102, 119, 77];
    },
  ];
  events: [
    {
      name: 'claimerChanged';
      discriminator: [58, 116, 209, 125, 102, 22, 183, 26];
    },
    {
      name: 'cpFeeCollected';
      discriminator: [33, 223, 81, 151, 208, 80, 188, 1];
    },
    {
      name: 'emergencyChanged';
      discriminator: [216, 70, 157, 227, 147, 10, 142, 77];
    },
    {
      name: 'emergencyWithdrawed';
      discriminator: [139, 158, 121, 121, 239, 210, 1, 50];
    },
    {
      name: 'executorChanged';
      discriminator: [231, 13, 59, 234, 251, 184, 82, 224];
    },
    {
      name: 'managerChanged';
      discriminator: [142, 97, 175, 220, 73, 27, 252, 56];
    },
    {
      name: 'nftPositionDeposited';
      discriminator: [59, 70, 235, 200, 51, 202, 245, 222];
    },
    {
      name: 'vaultInitialized';
      discriminator: [180, 43, 207, 2, 18, 71, 3, 75];
    },
  ];
  errors: [
    {
      code: 6000;
      name: 'unauthorized';
      msg: 'Unauthorized access attempt';
    },
    {
      code: 6001;
      name: 'positionNotFound';
      msg: 'Position not found';
    },
    {
      code: 6002;
      name: 'claimerNotFound';
      msg: 'Claimer not found';
    },
    {
      code: 6003;
      name: 'invalidPosition';
      msg: 'Invalid position';
    },
    {
      code: 6004;
      name: 'invalidAuthority';
      msg: 'Invalid authority';
    },
    {
      code: 6005;
      name: 'invalidFeeClaimer';
      msg: 'Invalid fee claimer';
    },
    {
      code: 6006;
      name: 'invalidToken';
      msg: 'Invalid token or NFT';
    },
    {
      code: 6007;
      name: 'invalidClaimerAddress';
      msg: 'Invalid claimer address';
    },
    {
      code: 6008;
      name: 'balanceOverflow';
      msg: 'Balance Overflow';
    },
    {
      code: 6009;
      name: 'invalidNftOwner';
      msg: 'Invalid NFT Owner';
    },
    {
      code: 6010;
      name: 'onlyOneNftAllowed';
      msg: 'Only One NFT Allowed';
    },
    {
      code: 6011;
      name: 'insufficientBalance';
      msg: 'Insufficient Balance';
    },
  ];
  types: [
    {
      name: 'claimerChanged';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'oldClaimer';
            type: 'pubkey';
          },
          {
            name: 'newClaimer';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'cpFeeCollected';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'claimer';
            type: 'pubkey';
          },
          {
            name: 'positionNft';
            type: 'pubkey';
          },
          {
            name: 'claimedTime';
            type: 'i64';
          },
        ];
      };
    },
    {
      name: 'emergencyChanged';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'oldEmergency';
            type: 'pubkey';
          },
          {
            name: 'newEmergency';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'emergencyWithdrawed';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'claimer';
            type: 'pubkey';
          },
          {
            name: 'positionNft';
            type: 'pubkey';
          },
          {
            name: 'withdrawedTime';
            type: 'i64';
          },
        ];
      };
    },
    {
      name: 'executorChanged';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'oldExecutor';
            type: 'pubkey';
          },
          {
            name: 'newExecutor';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'initVaultConfig';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'executorAuthority';
            type: 'pubkey';
          },
          {
            name: 'emergencyAuthority';
            type: 'pubkey';
          },
          {
            name: 'managerAuthority';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'lockedCpLiquidityState';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'lockedLpAmount';
            docs: ['The Locked liquidity amount without claimed lp fee'];
            type: 'u64';
          },
          {
            name: 'claimedLpAmount';
            docs: ['Claimed lp fee amount'];
            type: 'u64';
          },
          {
            name: 'unclaimedLpAmount';
            docs: ['Unclaimed lp fee amount'];
            type: 'u64';
          },
          {
            name: 'lastLp';
            docs: ['Last updated cp pool lp total supply'];
            type: 'u64';
          },
          {
            name: 'lastK';
            docs: ['Last updated cp pool k'];
            type: 'u128';
          },
          {
            name: 'recentEpoch';
            docs: ['Account update recent epoch'];
            type: 'u64';
          },
          {
            name: 'poolId';
            docs: ['The ID of the pool with which this record is connected'];
            type: 'pubkey';
          },
          {
            name: 'feeNftMint';
            docs: ['nft mint to check who has authority to collect fee'];
            type: 'pubkey';
          },
          {
            name: 'lockedOwner';
            docs: ['The owner who has locked liquidity'];
            type: 'pubkey';
          },
          {
            name: 'lockedLpMint';
            docs: ['The mint of locked lp token'];
            type: 'pubkey';
          },
          {
            name: 'padding';
            docs: ['Unused bytes for future upgrades.'];
            type: {
              array: ['u64', 8];
            };
          },
        ];
      };
    },
    {
      name: 'managerChanged';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'oldManager';
            type: 'pubkey';
          },
          {
            name: 'newManager';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'nftPositionDeposited';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'positionNft';
            type: 'pubkey';
          },
          {
            name: 'claimer';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'userPosition';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'claimer';
            docs: ['The owner of this position'];
            type: 'pubkey';
          },
          {
            name: 'positionNft';
            docs: ['The NFT or token representing this position'];
            type: 'pubkey';
          },
          {
            name: 'amount';
            docs: ['The amount deposited in this position (default 1 for NFTs)'];
            type: 'u8';
          },
          {
            name: 'createdAt';
            docs: ['Timestamp when the position was created'];
            type: 'i64';
          },
          {
            name: 'lastUpdated';
            docs: ['Timestamp of the last update to the position'];
            type: 'i64';
          },
        ];
      };
    },
    {
      name: 'vaultConfig';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'executorAuthority';
            docs: ['The authority that can manage executing operations'];
            type: 'pubkey';
          },
          {
            name: 'emergencyAuthority';
            docs: ['The authority that can manage emergency operations'];
            type: 'pubkey';
          },
          {
            name: 'managerAuthority';
            docs: ['The authority that can manage administrative operations'];
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'vaultInitialized';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'executor';
            type: 'pubkey';
          },
          {
            name: 'emergency';
            type: 'pubkey';
          },
          {
            name: 'manager';
            type: 'pubkey';
          },
        ];
      };
    },
  ];
};
