// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import "../src/StdError.sol";
import "../src/Test.sol";

contract StdErrorsTest is Test {
    ErrorsTest test;

    function setUp() public {
        test = new ErrorsTest();
    }

    function testExpectAssertion() public {
        vm.expectRevert(stdError.assertionError);
        test.assertionError();
    }

    function testExpectArithmetic() public {
        vm.expectRevert(stdError.arithmeticError);
        test.arithmeticError(10);
    }

    function testExpectDiv() public {
        vm.expectRevert(stdError.divisionError);
        test.divError(0);
    }

    function testExpectMod() public {
        vm.expectRevert(stdError.divisionError);
        test.modError(0);
    }

    function testExpectEnum() public {
        vm.expectRevert(stdError.enumConversionError);
        test.enumConversion(1);
    }

    function testExpectEncodeStg() public {
        vm.expectRevert(stdError.encodeStorageError);
        test.encodeStgError();
    }

    function testExpectPop() public {
        vm.expectRevert(stdError.popError);
        test.pop();
    }

    function testExpectOOB() public {
        vm.expectRevert(stdError.indexOOBError);
        test.indexOOBError(1);
    }

    function testExpectMem() public {
        vm.expectRevert(stdError.memOverflowError);
        test.mem();
    }

    function testExpectIntern() public {
        vm.expectRevert(stdError.zeroVarError);
        test.intern();
    }
}

contract ErrorsTest {
    enum T {T1}

    uint256[] public someArr;
    bytes someBytes;

    function assertionError() public pure {
        assert(false);
    }

    function arithmeticError(uint256 a) public pure {
        a -= 100;
    }

    function divError(uint256 a) public pure {
        100 / a;
    }

    function modError(uint256 a) public pure {
        100 % a;
    }

    function enumConversion(uint256 a) public pure {
        T(a);
    }

    function encodeStgError() public {
        /// @solidity memory-safe-assembly
        assembly {
            sstore(someBytes.slot, 1)
        }
        keccak256(someBytes);
    }

    function pop() public {
        someArr.pop();
    }

    function indexOOBError(uint256 a) public pure {
        uint256[] memory t = new uint256[](0);
        t[a];
    }

    function mem() public pure {
        uint256 l = 2 ** 256 / 32;
        new uint256[](l);
    }

    function intern() public returns (uint256) {
        function(uint256) internal returns (uint256) x;
        x(2);
        return 7;
    }
}
