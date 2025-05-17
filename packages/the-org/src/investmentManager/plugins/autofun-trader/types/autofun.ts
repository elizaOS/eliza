/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/autofun.json`.
 */
export type Autofun = {
  address: 'autoUmixaMaYKFjexMpQuBpNYntgbkzCo2b1ZqUaAZ5';
  metadata: {
    name: 'autofun';
    version: '0.1.0';
    spec: '0.1.0';
    description: 'Created with Anchor';
  };
  instructions: [
    {
      name: 'acceptAuthority';
      discriminator: [107, 86, 198, 91, 33, 12, 107, 160];
      accounts: [
        {
          name: 'newAdmin';
          writable: true;
          signer: true;
        },
        {
          name: 'globalConfig';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
      ];
      args: [];
    },
    {
      name: 'configure';
      discriminator: [245, 7, 108, 117, 95, 196, 54, 217];
      accounts: [
        {
          name: 'payer';
          writable: true;
          signer: true;
        },
        {
          name: 'config';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'globalVault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [103, 108, 111, 98, 97, 108];
              },
            ];
          };
        },
        {
          name: 'globalWsolAccount';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'globalVault';
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
                path: 'nativeMint';
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
          name: 'nativeMint';
          address: 'So11111111111111111111111111111111111111112';
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
        {
          name: 'tokenProgram';
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        },
        {
          name: 'associatedTokenProgram';
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
        },
      ];
      args: [
        {
          name: 'newConfig';
          type: {
            defined: {
              name: 'config';
            };
          };
        },
      ];
    },
    {
      name: 'launch';
      discriminator: [153, 241, 93, 225, 22, 69, 74, 61];
      accounts: [
        {
          name: 'globalConfig';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'globalVault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [103, 108, 111, 98, 97, 108];
              },
            ];
          };
        },
        {
          name: 'creator';
          writable: true;
          signer: true;
        },
        {
          name: 'token';
          writable: true;
          signer: true;
        },
        {
          name: 'bondingCurve';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [98, 111, 110, 100, 105, 110, 103, 95, 99, 117, 114, 118, 101];
              },
              {
                kind: 'account';
                path: 'token';
              },
            ];
          };
        },
        {
          name: 'tokenMetadataAccount';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [109, 101, 116, 97, 100, 97, 116, 97];
              },
              {
                kind: 'const';
                value: [
                  11,
                  112,
                  101,
                  177,
                  227,
                  209,
                  124,
                  69,
                  56,
                  157,
                  82,
                  127,
                  107,
                  4,
                  195,
                  205,
                  88,
                  184,
                  108,
                  115,
                  26,
                  160,
                  253,
                  181,
                  73,
                  182,
                  209,
                  188,
                  3,
                  248,
                  41,
                  70,
                ];
              },
              {
                kind: 'account';
                path: 'token';
              },
            ];
            program: {
              kind: 'const';
              value: [
                11,
                112,
                101,
                177,
                227,
                209,
                124,
                69,
                56,
                157,
                82,
                127,
                107,
                4,
                195,
                205,
                88,
                184,
                108,
                115,
                26,
                160,
                253,
                181,
                73,
                182,
                209,
                188,
                3,
                248,
                41,
                70,
              ];
            };
          };
        },
        {
          name: 'globalTokenAccount';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'globalVault';
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
                path: 'token';
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
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
        {
          name: 'rent';
          address: 'SysvarRent111111111111111111111111111111111';
        },
        {
          name: 'tokenProgram';
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        },
        {
          name: 'associatedTokenProgram';
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
        },
        {
          name: 'mplTokenMetadataProgram';
          address: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
        },
        {
          name: 'teamWallet';
          writable: true;
        },
        {
          name: 'teamWalletAta';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'teamWallet';
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
                path: 'token';
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
      ];
      args: [
        {
          name: 'decimals';
          type: 'u8';
        },
        {
          name: 'tokenSupply';
          type: 'u64';
        },
        {
          name: 'virtualLamportReserves';
          type: 'u64';
        },
        {
          name: 'name';
          type: 'string';
        },
        {
          name: 'symbol';
          type: 'string';
        },
        {
          name: 'uri';
          type: 'string';
        },
      ];
    },
    {
      name: 'launchAndSwap';
      discriminator: [67, 201, 190, 15, 185, 41, 47, 122];
      accounts: [
        {
          name: 'globalConfig';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'globalVault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [103, 108, 111, 98, 97, 108];
              },
            ];
          };
        },
        {
          name: 'creator';
          writable: true;
          signer: true;
        },
        {
          name: 'token';
          writable: true;
          signer: true;
        },
        {
          name: 'bondingCurve';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [98, 111, 110, 100, 105, 110, 103, 95, 99, 117, 114, 118, 101];
              },
              {
                kind: 'account';
                path: 'token';
              },
            ];
          };
        },
        {
          name: 'tokenMetadataAccount';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [109, 101, 116, 97, 100, 97, 116, 97];
              },
              {
                kind: 'const';
                value: [
                  11,
                  112,
                  101,
                  177,
                  227,
                  209,
                  124,
                  69,
                  56,
                  157,
                  82,
                  127,
                  107,
                  4,
                  195,
                  205,
                  88,
                  184,
                  108,
                  115,
                  26,
                  160,
                  253,
                  181,
                  73,
                  182,
                  209,
                  188,
                  3,
                  248,
                  41,
                  70,
                ];
              },
              {
                kind: 'account';
                path: 'token';
              },
            ];
            program: {
              kind: 'const';
              value: [
                11,
                112,
                101,
                177,
                227,
                209,
                124,
                69,
                56,
                157,
                82,
                127,
                107,
                4,
                195,
                205,
                88,
                184,
                108,
                115,
                26,
                160,
                253,
                181,
                73,
                182,
                209,
                188,
                3,
                248,
                41,
                70,
              ];
            };
          };
        },
        {
          name: 'globalTokenAccount';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'globalVault';
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
                path: 'token';
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
          name: 'teamWallet';
          writable: true;
        },
        {
          name: 'teamWalletAta';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'teamWallet';
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
                path: 'token';
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
          name: 'userAta';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'creator';
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
                path: 'token';
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
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
        {
          name: 'rent';
          address: 'SysvarRent111111111111111111111111111111111';
        },
        {
          name: 'tokenProgram';
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        },
        {
          name: 'associatedTokenProgram';
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
        },
        {
          name: 'mplTokenMetadataProgram';
          address: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
        },
      ];
      args: [
        {
          name: 'decimals';
          type: 'u8';
        },
        {
          name: 'tokenSupply';
          type: 'u64';
        },
        {
          name: 'virtualLamportReserves';
          type: 'u64';
        },
        {
          name: 'name';
          type: 'string';
        },
        {
          name: 'symbol';
          type: 'string';
        },
        {
          name: 'uri';
          type: 'string';
        },
        {
          name: 'swapAmount';
          type: 'u64';
        },
        {
          name: 'minimumReceiveAmount';
          type: 'u64';
        },
        {
          name: 'deadline';
          type: 'i64';
        },
      ];
      returns: 'u64';
    },
    {
      name: 'nominateAuthority';
      discriminator: [148, 182, 144, 91, 186, 12, 118, 18];
      accounts: [
        {
          name: 'admin';
          writable: true;
          signer: true;
        },
        {
          name: 'globalConfig';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
      ];
      args: [
        {
          name: 'newAdmin';
          type: 'pubkey';
        },
      ];
    },
    {
      name: 'swap';
      discriminator: [248, 198, 158, 145, 225, 117, 135, 200];
      accounts: [
        {
          name: 'globalConfig';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'teamWallet';
          writable: true;
        },
        {
          name: 'teamWalletAta';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'teamWallet';
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
                path: 'tokenMint';
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
          name: 'bondingCurve';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [98, 111, 110, 100, 105, 110, 103, 95, 99, 117, 114, 118, 101];
              },
              {
                kind: 'account';
                path: 'tokenMint';
              },
            ];
          };
        },
        {
          name: 'globalVault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [103, 108, 111, 98, 97, 108];
              },
            ];
          };
        },
        {
          name: 'tokenMint';
        },
        {
          name: 'globalAta';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'globalVault';
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
                path: 'tokenMint';
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
          name: 'userAta';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'user';
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
                path: 'tokenMint';
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
          name: 'user';
          writable: true;
          signer: true;
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
        {
          name: 'tokenProgram';
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        },
        {
          name: 'associatedTokenProgram';
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
        },
      ];
      args: [
        {
          name: 'amount';
          type: 'u64';
        },
        {
          name: 'direction';
          type: 'u8';
        },
        {
          name: 'minimumReceiveAmount';
          type: 'u64';
        },
        {
          name: 'deadline';
          type: 'i64';
        },
      ];
      returns: 'u64';
    },
    {
      name: 'withdraw';
      discriminator: [183, 18, 70, 156, 148, 109, 161, 34];
      accounts: [
        {
          name: 'globalConfig';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'globalVault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [103, 108, 111, 98, 97, 108];
              },
            ];
          };
        },
        {
          name: 'admin';
          writable: true;
          signer: true;
        },
        {
          name: 'tokenMint';
        },
        {
          name: 'bondingCurve';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [98, 111, 110, 100, 105, 110, 103, 95, 99, 117, 114, 118, 101];
              },
              {
                kind: 'account';
                path: 'tokenMint';
              },
            ];
          };
        },
        {
          name: 'globalVaultAta';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'globalVault';
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
                path: 'tokenMint';
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
          name: 'adminAta';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'admin';
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
                path: 'tokenMint';
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
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
        {
          name: 'tokenProgram';
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        },
        {
          name: 'associatedTokenProgram';
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
        },
      ];
      args: [];
    },
  ];
  accounts: [
    {
      name: 'bondingCurve';
      discriminator: [23, 183, 248, 55, 96, 216, 172, 96];
    },
    {
      name: 'config';
      discriminator: [155, 12, 170, 224, 30, 250, 204, 130];
    },
  ];
  events: [
    {
      name: 'completeEvent';
      discriminator: [95, 114, 97, 156, 212, 46, 152, 8];
    },
  ];
  errors: [
    {
      code: 6000;
      name: 'valueTooSmall';
      msg: 'valueTooSmall';
    },
    {
      code: 6001;
      name: 'valueTooLarge';
      msg: 'valueTooLarge';
    },
    {
      code: 6002;
      name: 'valueInvalid';
      msg: 'valueInvalid';
    },
    {
      code: 6003;
      name: 'incorrectConfigAccount';
      msg: 'incorrectConfigAccount';
    },
    {
      code: 6004;
      name: 'incorrectAuthority';
      msg: 'incorrectAuthority';
    },
    {
      code: 6005;
      name: 'overflowOrUnderflowOccurred';
      msg: 'Overflow or underflow occured';
    },
    {
      code: 6006;
      name: 'invalidAmount';
      msg: 'Amount is invalid';
    },
    {
      code: 6007;
      name: 'incorrectTeamWallet';
      msg: 'Incorrect team wallet address';
    },
    {
      code: 6008;
      name: 'curveNotCompleted';
      msg: 'Curve is not completed';
    },
    {
      code: 6009;
      name: 'curveAlreadyCompleted';
      msg: 'Can not swap after the curve is completed';
    },
    {
      code: 6010;
      name: 'mintAuthorityEnabled';
      msg: 'Mint authority should be revoked';
    },
    {
      code: 6011;
      name: 'freezeAuthorityEnabled';
      msg: 'Freeze authority should be revoked';
    },
    {
      code: 6012;
      name: 'returnAmountTooSmall';
      msg: 'Return amount is too small compared to the minimum received amount';
    },
    {
      code: 6013;
      name: 'transactionExpired';
      msg: 'Transaction expired';
    },
    {
      code: 6014;
      name: 'decimalOverflow';
      msg: 'Decimal overflow';
    },
  ];
  types: [
    {
      name: 'amountConfig';
      generics: [
        {
          kind: 'type';
          name: 't';
        },
      ];
      type: {
        kind: 'enum';
        variants: [
          {
            name: 'range';
            fields: [
              {
                name: 'min';
                type: {
                  option: {
                    generic: 't';
                  };
                };
              },
              {
                name: 'max';
                type: {
                  option: {
                    generic: 't';
                  };
                };
              },
            ];
          },
          {
            name: 'enum';
            fields: [
              {
                vec: {
                  generic: 't';
                };
              },
            ];
          },
        ];
      };
    },
    {
      name: 'bondingCurve';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'tokenMint';
            type: 'pubkey';
          },
          {
            name: 'creator';
            type: 'pubkey';
          },
          {
            name: 'initLamport';
            type: 'u64';
          },
          {
            name: 'reserveLamport';
            type: 'u64';
          },
          {
            name: 'reserveToken';
            type: 'u64';
          },
          {
            name: 'curveLimit';
            type: 'u64';
          },
          {
            name: 'isCompleted';
            type: 'bool';
          },
        ];
      };
    },
    {
      name: 'completeEvent';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'user';
            type: 'pubkey';
          },
          {
            name: 'mint';
            type: 'pubkey';
          },
          {
            name: 'bondingCurve';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'config';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'authority';
            type: 'pubkey';
          },
          {
            name: 'pendingAuthority';
            type: 'pubkey';
          },
          {
            name: 'teamWallet';
            type: 'pubkey';
          },
          {
            name: 'initBondingCurve';
            type: 'f64';
          },
          {
            name: 'platformBuyFee';
            type: 'u128';
          },
          {
            name: 'platformSellFee';
            type: 'u128';
          },
          {
            name: 'curveLimit';
            type: 'u64';
          },
          {
            name: 'lamportAmountConfig';
            type: {
              defined: {
                name: 'amountConfig';
                generics: [
                  {
                    kind: 'type';
                    type: 'u64';
                  },
                ];
              };
            };
          },
          {
            name: 'tokenSupplyConfig';
            type: {
              defined: {
                name: 'amountConfig';
                generics: [
                  {
                    kind: 'type';
                    type: 'u64';
                  },
                ];
              };
            };
          },
          {
            name: 'tokenDecimalsConfig';
            type: {
              defined: {
                name: 'amountConfig';
                generics: [
                  {
                    kind: 'type';
                    type: 'u8';
                  },
                ];
              };
            };
          },
        ];
      };
    },
  ];
};
