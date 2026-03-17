# Forge Standard Library • [![CI status](https://github.com/foundry-rs/forge-std/actions/workflows/ci.yml/badge.svg)](https://github.com/foundry-rs/forge-std/actions/workflows/ci.yml)

Forge Standard Library is a collection of helpful contracts and libraries for use with [Forge and Foundry](https://github.com/foundry-rs/foundry). It leverages Forge's cheatcodes to make writing tests easier and faster, while improving the UX of cheatcodes.

**Learn how to use Forge-Std with the [📖 Foundry Book (Forge-Std Guide)](https://book.getfoundry.sh/forge/forge-std.html).**

## Install

```bash
forge install foundry-rs/forge-std
```

## Contracts
### stdError

This is a helper contract for errors and reverts. In Forge, this contract is particularly helpful for the `expectRevert` cheatcode, as it provides all compiler builtin errors.

See the contract itself for all error codes.

#### Example usage

```solidity

import "forge-std/Test.sol";

contract TestContract is Test {
    ErrorsTest test;

    function setUp() public {
        test = new ErrorsTest();
    }

    function testExpectArithmetic() public {
        vm.expectRevert(stdError.arithmeticError);
        test.arithmeticError(10);
    }
}

contract ErrorsTest {
    function arithmeticError(uint256 a) public {
        uint256 a = a - 100;
    }
}
```

### stdStorage

This is a rather large contract due to all of the overloading to make the UX decent. Primarily, it is a wrapper around the `record` and `accesses` cheatcodes. It can *always* find and write the storage slot(s) associated with a particular variable without knowing the storage layout. The one _major_ caveat to this is while a slot can be found for packed storage variables, we can't write to that variable safely. If a user tries to write to a packed slot, the execution throws an error, unless it is uninitialized (`bytes32(0)`).

This works by recording all `SLOAD`s and `SSTORE`s during a function call. If there is a single slot read or written to, it immediately returns the slot. Otherwise, behind the scenes, we iterate through and check each one (assuming the user passed in a `depth` parameter). If the variable is a struct, you can pass in a `depth` parameter which is basically the field depth.

I.e.:
```solidity
struct T {
    // depth 0
    uint256 a;
    // depth 1
    uint256 b;
}
```

#### Example usage

```solidity
import "forge-std/Test.sol";

contract TestContract is Test {
    using stdStorage for StdStorage;

    Storage test;

    function setUp() public {
        test = new Storage();
    }

    function testFindExists() public {
        // Lets say we want to find the slot for the public
        // variable `exists`. We just pass in the function selector
        // to the `find` command
        uint256 slot = stdstore.target(address(test)).sig("exists()").find();
        assertEq(slot, 0);
    }

    function testWriteExists() public {
        // Lets say we want to write to the slot for the public
        // variable `exists`. We just pass in the function selector
        // to the `checked_write` command
        stdstore.target(address(test)).sig("exists()").checked_write(100);
        assertEq(test.exists(), 100);
    }

    // It supports arbitrary storage layouts, like assembly based storage locations
    function testFindHidden() public {
        // `hidden` is a random hash of a bytes, iteration through slots would
        // not find it. Our mechanism does
        // Also, you can use the selector instead of a string
        uint256 slot = stdstore.target(address(test)).sig(test.hidden.selector).find();
        assertEq(slot, uint256(keccak256("my.random.var")));
    }

    // If targeting a mapping, you have to pass in the keys necessary to perform the find
    // i.e.:
    function testFindMapping() public {
        uint256 slot = stdstore
            .target(address(test))
            .sig(test.map_addr.selector)
            .with_key(address(this))
            .find();
        // in the `Storage` constructor, we wrote that this address' value was 1 in the map
        // so when we load the slot, we expect it to be 1
        assertEq(uint(vm.load(address(test), bytes32(slot))), 1);
    }

    // If the target is a struct, you can specify the field depth:
    function testFindStruct() public {
        // NOTE: see the depth parameter - 0 means 0th field, 1 means 1st field, etc.
        uint256 slot_for_a_field = stdstore
            .target(address(test))
            .sig(test.basicStruct.selector)
            .depth(0)
            .find();

        uint256 slot_for_b_field = stdstore
            .target(address(test))
            .sig(test.basicStruct.selector)
            .depth(1)
            .find();

        assertEq(uint(vm.load(address(test), bytes32(slot_for_a_field))), 1);
        assertEq(uint(vm.load(address(test), bytes32(slot_for_b_field))), 2);
    }
}

// A complex storage contract
contract Storage {
    struct UnpackedStruct {
        uint256 a;
        uint256 b;
    }

    constructor() {
        map_addr[msg.sender] = 1;
    }

    uint256 public exists = 1;
    mapping(address => uint256) public map_addr;
    // mapping(address => Packed) public map_packed;
    mapping(address => UnpackedStruct) public map_struct;
    mapping(address => mapping(address => uint256)) public deep_map;
    mapping(address => mapping(address => UnpackedStruct)) public deep_map_struct;
    UnpackedStruct public basicStruct = UnpackedStruct({
        a: 1,
        b: 2
    });

    function hidden() public view returns (bytes32 t) {
        // an extremely hidden storage slot
        bytes32 slot = keccak256("my.random.var");
        assembly {
            t := sload(slot)
        }
    }
}
```

### stdCheats

This is a wrapper over miscellaneous cheatcodes that need wrappers to be more dev friendly. Currently there are only functions related to `prank`. In general, users may expect ETH to be put into an address on `prank`, but this is not the case for safety reasons. Explicitly this `hoax` function should only be used for address that have expected balances as it will get overwritten. If an address already has ETH, you should just use `prank`. If you want to change that balance explicitly, just use `deal`. If you want to do both, `hoax` is also right for you.


#### Example usage:
```solidity

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";

// Inherit the stdCheats
contract StdCheatsTest is Test {
    Bar test;
    function setUp() public {
        test = new Bar();
    }

    function testHoax() public {
        // we call `hoax`, which gives the target address
        // eth and then calls `prank`
        hoax(address(1337));
        test.bar{value: 100}(address(1337));

        // overloaded to allow you to specify how much eth to
        // initialize the address with
        hoax(address(1337), 1);
        test.bar{value: 1}(address(1337));
    }

    function testStartHoax() public {
        // we call `startHoax`, which gives the target address
        // eth and then calls `startPrank`
        //
        // it is also overloaded so that you can specify an eth amount
        startHoax(address(1337));
        test.bar{value: 100}(address(1337));
        test.bar{value: 100}(address(1337));
        vm.stopPrank();
        test.bar(address(this));
    }
}

contract Bar {
    function bar(address expectedSender) public payable {
        require(msg.sender == expectedSender, "!prank");
    }
}
```

### Std Assertions

Expand upon the assertion functions from the `DSTest` library.

### `console.log`

Usage follows the same format as [Hardhat](https://hardhat.org/hardhat-network/reference/#console-log).
It's recommended to use `console2.sol` as shown below, as this will show the decoded logs in Forge traces.

```solidity
// import it indirectly via Test.sol
import "forge-std/Test.sol";
// or directly import it
import "forge-std/console2.sol";
...
console2.log(someValue);
```

If you need compatibility with Hardhat, you must use the standard `console.sol` instead.
Due to a bug in `console.sol`, logs that use `uint256` or `int256` types will not be properly decoded in Forge traces.

```solidity
// import it indirectly via Test.sol
import "forge-std/Test.sol";
// or directly import it
import "forge-std/console.sol";
...
console.log(someValue);
```

## License

Forge Standard Library is offered under either [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE) license.
