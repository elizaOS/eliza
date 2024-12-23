# Bagel fine tuning

## Setup

Go to [bakery.bagel.net](https://bakery.bagel.net) and create an account. Then get an API key.

Set the `BAGEL_API_KEY` environment variable to your API key.

In bakery, create your model and fine-tune dataset.

## Fine-tune with Eliza

```bash
curl -X POST http://localhost:3000/fine-tune \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer jvBpxrTNqGqhnfQhSEqCdsG6aTSP8IBL" \
  -d '{
    "dataset_type": "MODEL",
    "title": "smollm2-fine-tuning-00000099",
    "category": "AI",
    "details": "Test",
    "tags": [],
    "user_id": "96c633e6-e973-446e-b782-6235324c0a56",
    "fine_tune_payload": {
      "asset_id": "d0a3f665-c207-4ee6-9daa-0cbdb272eeca",
      "model_name": "llama3-fine-tuning-00000001",
      "base_model": "0488b40b-829f-4c3a-9880-d55d76775dd1",
      "file_name": "qa_data.csv",
      "epochs": 1,
      "learning_rate": 0.01,
      "user_id": "96c633e6-e973-446e-b782-6235324c0a56",
      "use_ipfs": "false",
      "input_column": "question",
      "output_column": "answer"
    }
  }'
```

This can take a while to complete. You can check the status of the fine-tune job in the bakery dashboard. When it is complete, you can download the fine-tuned model here:

```bash
curl -X GET "http://localhost:3000/fine-tune/8566c47a-ada8-441c-95bc-7bb07656c4c1" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer jvBpxrTNqGqhnfQhSEqCdsG6aTSP8IBL".
```



## Verifiable Attestations

This function relies on  [plugin-tee-verifiable-log](../../plugin-tee-verifiable-log/README.md)

Enable Verifiable Logs, Configuration variables in .env
```shell
TEE_MODE="DOCKER"                    # LOCAL | DOCKER | PRODUCTION
WALLET_SECRET_SALT= "<your wallet secret salt>"            # ONLY define if you want to use TEE Plugin, otherwise it will throw errors
VLOG="true"
```
### APIs
### 1. Get verifiable agents
```shell
curl -X GET --location "http://localhost:3000/verifiable/agents"
```
* Response success result
```shell
{
  "success": true,
  "message": "Successfully get Agents",
  "data": [
    {
      "id": "c4598810-61a2-4ac8-ab85-b746402692c4",
      "created_at": 1734526797906,
      "agent_id": "9c321604-e69e-0e4c-ab84-bec6fd6baf92",
      "agent_name": "Capila",
      "agent_keypair_path": "/keys/verifiable_key",
      "agent_keypair_vlog_pk": "0x045b51a28c3b071104f3094b1934343eb831b8d56f16fc6..."
    }
  ]
}
```
* Response failure  result
```shell
{
  "error": "failed to get agents registered ",
  "details": "Cannot read properties of undefined (reading 'getService')",
  "stack": "TypeError: Cannot read ..."
}
```

### 2.Query verifiable logs
```bash

curl -X POST --location "http://localhost:3000/verifiable/logs" \
    -H "Content-Type: application/json" \
    -d '{
          "query": {
            "contLike": "Twinkletwinkle"
          },
          "page": 1,
          "pageSize": 10
        }'      
```
The query body that can be queried are：
>* idEq: string;
>* agentIdEq: string;
>* roomIdEq: string;
>* userIdEq: string;
>* typeEq: string;
>* contLike: string;
>* signatureEq: string;

* Response success result
```shell
{
  "success": true,
  "message": "Successfully retrieved logs",
  "data": {
    "page": 1,
    "pageSize": 10,
    "total": 1,
    "data": [
      {
        "id": "b9ac4b2f-ecb5-4c5c-a981-d282b831e878",
        "created_at": 1734526805664,
        "agent_id": "9c321604-e69e-0e4c-ab84-bec6fd6baf92",
        "room_id": "8c54580d-2c56-01e8-81e4-4160a02f3ee5",
        "user_id": "9c321604-e69e-0e4c-ab84-bec6fd6baf92",
        "type": "post tweet",
        "content": "{\"text\":\"Twinkletwinkle, it's time to unlock your artistic values!\\n\\n My NFTs are here to bring the chill vibes to Web3.\\n\\n Let's wagmi and make this a day to remember!\",\"url\":\"https://twitter.com/....\"}",
        "signature": "0x9ac77cfef9374bff3b41f96d0b0a8d61bfcf88e3a01f7bc20653494145ff31ef118a2a3cd94437481000a13500c6ed6714d8802bf2572a7da4de2e81a688d0b41c"
      }
    ]
  }
}
```
* Response failure  result
```shell

{
  "error": "Failed to Get Verifiable Logs",
  "details": "Cannot read properties of undefined (reading 'getService')",
  "stack": "TypeError: Cannot read ..."
}
```


### 3.Get Tee Attestation
```shell
curl -X POST --location "http://localhost:3000/verifiable/attestation" \
    -H "Content-Type: application/json" \
    -d '{
          "agentId": "9c321604-e69e-0e4c-ab84-bec6fd6baf92",
          "publicKey": "0x045b51a28c3b071104f3094b1934343eb831b8d56f16fc6e9a3304e9f051b24e584d806b20769b05eeade3a6c792db96f57b26cc38037907dd920e9be9f41f6184"
        }'
``` 
* Response success result
```shell
{
  "success": true,
  "message": "Successfully get Attestation",
  "data": "{\"quote\":\"0x04000300810000000e934d64208ed62112d13060cf062a398f78a9516b9f884ee7ad145e875b59592b09598ce02e4d4983ae4decab71f5147acd16a26326e01075a8d5b709727224bba449c9cd7fc2b490ea23d9e01cd932221d8b86a0a8a7be25c25571bceef0427131860fe0cb295b0d25e5ed1488d9a122c24ba4c1494c2a2578535c556752850c6bbd60c2482b5bb10b5157fe5f42b637457262fd4d8a92575b307f5453c1982a841b46cd60858a3f8ced7ca2ba1c02cf9fec3f23b30bbe8e30378e116bea58b4068bf0379964b6adcb2f680f4646b26a21bed6f8ac06f468cc356db0b2769638a02a7d6e0b69ae297304c62a1fd800703e8bfd340901b6ad412d9433eee04b67ab86311ebb4ee2f3a758ea3fda0e89f45c7ec9ca28e2d525fab6d3e62c3e2b6788dd9dec6e367975c0ac5f6c2aad436e14c75dd99a94c51d882efc0ea44ca8c251e3384b24a88af39ab070b65387ee5e0fd11212852663248c6f24a646c163273348ea03f99d028022b08e09b0b992d9b49c61246b298c3ec827af4973a57bc017a35e0f22750922f2cae660ed70797695c5c65104339f912e1da35a7c625e5fa470764228efe80309762e33ea295b8fd6bae7ef9e7f9a4210deaac322d26acf4e003aded3099c90d6f5c1caa6fb9d84e4f70da3ea1fbfd76c2c7bb544375f566a5182e142da67718a4db7b373ff7e8b4e14bf5a752c5cf88002555020a2a4938978849c1774810456a8fe89769a595676eb0fdadda83540d353efdd40a3efcfb80283abc942e9348d3fe04109fd9999ed6fae17b5d8de88dcd80e5d57cd576ffb7a21780bd6064b4e61f83d1ff1088e836f2a8aa4cdee685aa02303cb809a6e45997532d372b5b519d3ae03f08cb162020000f5672ea83d7b1e145824622fea621381d7b6a110b1b0fdda4e4e2c3565431d099e74829267a01345a2780d0387173419e23bdb72ea57294c696e14ac8198e0967e30dc93a361465d109c1a54f47c117adcba95fdc2cecbd2b35ba3fc7443d80f56e16499d4a85ae2970428848487f963c9366898b34ebbb349dc162d2127f2800000dc010000149f9a1f60ae565575037121aac4f9a10cf6d6e884df2aac1c2bb83f8cad17d0d27f7d4264bdb78a9fe056aba38ff666b22642a9471f351f04afa7ad727f80a1ecab742174c46b33f034fc43cdef08afde65b93aeb94db20b705b379407e50a648db3a3f5958ac29f9bcc32a46a3ea36be27bc049a1409e8543467926afce68eed7488c7120ff3bd6d79c61078111d285e13fc365c82da04469a77101e067bc24f0c4fd27c361430292b8af92f07ac2687532e36377a9c67fa65a17a1dedba2aabac079d3ee691fcdf3e10bf7a479ee58e27085f5ac700a2252899cd88ba13ab00b1cf12cbfca3bcdacaf870e904191bdf2e7426c86b092380fbb523086c294aaf64f3931c96ec7292e4a0aee03f4b0f0eb757d1dc96c7fd07dcad6d51622060e5db55cae0c45aab399caa785665302fff467b1caa98e4ef2bac9a02911388a44b69cf7f21bf3c2ce2da95f323ea3717eddfe97f486beb90dc7ff88377211dd8a89d2b77d044fae1423904839ad8b4662d8df7a414c9aec2c234c0df878093fc31714d2fee3c400cfbee9df0ee82df7d7361d53a7ce91b01e80d3dc9702eebb8dafa1cb3e2a5032fd64ded06e5f1bacd9c275604cedabbea82cec2cfa32384790a000000000000000000000078c50a00000000000000000000000000\",\"timestamp\":1734626127589}"
}
```

* Response failure  result
```shell

{
  "error": "Failed to Get Verifiable Logs",
  "details": "Cannot read properties of undefined (reading 'getService')",
  "stack": "TypeError: Cannot read ..."
}
```
