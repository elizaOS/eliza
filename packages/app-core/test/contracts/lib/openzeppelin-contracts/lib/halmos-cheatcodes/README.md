# Halmos Cheat Codes

Halmos cheatcodes are abstract functions designed to facilitate writing symbolic tests, such as the creation of new symbolic values at runtime. While these cheatcodes are currently exclusive to [Halmos][halmos], they are not limited to it and could potentially be supported by other symbolic testing tools in the future.

Please refer to [the list of currently available cheatcodes][list]. More cheatcodes will be added in the future.

Join the [Halmos Telegram Group][chat] for any inquiries or further discussions.

[halmos]: <https://github.com/a16z/halmos>
[list]: <src/SVM.sol>
[chat]: <https://t.me/+4UhzHduai3MzZmUx>

## Installation

To install using Foundry:
```
forge install a16z/halmos-cheatcodes
```
Alternatively, you can directly add it as a submodule:
```
git submodule add https://github.com/a16z/halmos-cheatcodes
```

## Example usage

Below is an example of a symbolic test that checks for potential unauthorized access to others' tokens. The approach involves setting up an initial symbolic state of the token contract, executing an arbitrary function call to the token contract, and checking if there is an execution path that increases the caller's balance and/or decreases the balance of others. This example illustrates how to utilize cheatcodes to set up initial symbolic states and execute arbitrary function calls.

```solidity
// import Halmos cheatcodes
import {SymTest} from "halmos-cheatcodes/SymTest.sol";

import {Test} from "forge-std/Test.sol";

import {Token} from "/path/to/Token.sol";

contract TokenTest is SymTest, Test {
    Token token;

    function setUp() public {
        token = new Token();

        // set the balances of three arbitrary accounts to arbitrary symbolic values
        for (uint256 i = 0; i < 3; i++) {
            address receiver = svm.createAddress('receiver'); // create a new symbolic address
            uint256 amount = svm.createUint256('amount'); // create a new symbolic uint256 value
            token.transfer(receiver, amount);
        }
    }

    function checkBalanceUpdate() public {
        // consider two arbitrary distinct accounts
        address caller = svm.createAddress('caller'); // create a symbolic address
        address others = svm.createAddress('others'); // create another symbolic address
        vm.assume(others != caller); // assume the two addresses are different

        // record their current balances
        uint256 oldBalanceCaller = token.balanceOf(caller);
        uint256 oldBalanceOthers = token.balanceOf(others);

        // execute an arbitrary function call to the token from the caller
        vm.prank(caller);
        uint256 dataSize = 100; // the max calldata size for the public functions in the token
        bytes memory data = svm.createBytes(dataSize, 'data'); // create a symbolic calldata
        address(token).call(data);

        // ensure that the caller cannot spend others' tokens
        assert(token.balanceOf(caller) <= oldBalanceCaller); // cannot increase their own balance
        assert(token.balanceOf(others) >= oldBalanceOthers); // cannot decrease others' balance
    }
}
```

When running the above test against the following buggy token contract, Halmos will provide a counterexample that may be overlooked during manual reviews.

```solidity
/// @notice This is a buggy token contract. DO NOT use it in production.
contract Token {
    mapping(address => uint) public balanceOf;

    constructor() public {
        balanceOf[msg.sender] = 1e27;
    }

    function transfer(address to, uint amount) public {
        _transfer(msg.sender, to, amount);
    }

    function _transfer(address from, address to, uint amount) public {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
```

## Disclaimer

_These smart contracts and code are being provided as is. No guarantee, representation or warranty is being made, express or implied, as to the safety or correctness of the user interface or the smart contracts and code. They have not been audited and as such there can be no assurance they will work as intended, and users may experience delays, failures, errors, omissions or loss of transmitted information. THE SMART CONTRACTS AND CODE CONTAINED HEREIN ARE FURNISHED AS IS, WHERE IS, WITH ALL FAULTS AND WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING ANY WARRANTY OF MERCHANTABILITY, NON-INFRINGEMENT OR FITNESS FOR ANY PARTICULAR PURPOSE. Further, use of any of these smart contracts and code may be restricted or prohibited under applicable law, including securities laws, and it is therefore strongly advised for you to contact a reputable attorney in any jurisdiction where these smart contracts and code may be accessible for any questions or concerns with respect thereto. Further, no information provided in this repo should be construed as investment advice or legal advice for any particular facts or circumstances, and is not meant to replace competent counsel. a16z is not liable for any use of the foregoing, and users should proceed with caution and use at their own risk. See a16z.com/disclosures for more info._
