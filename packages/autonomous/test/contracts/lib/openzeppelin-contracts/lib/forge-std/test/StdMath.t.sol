// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import "../src/StdMath.sol";
import "../src/Test.sol";

contract StdMathTest is Test {
    function testGetAbs() external {
        assertEq(stdMath.abs(-50), 50);
        assertEq(stdMath.abs(50), 50);
        assertEq(stdMath.abs(-1337), 1337);
        assertEq(stdMath.abs(0), 0);

        assertEq(stdMath.abs(type(int256).min), (type(uint256).max >> 1) + 1);
        assertEq(stdMath.abs(type(int256).max), (type(uint256).max >> 1));
    }

    function testGetAbs_Fuzz(int256 a) external {
        uint256 manualAbs = getAbs(a);

        uint256 abs = stdMath.abs(a);

        assertEq(abs, manualAbs);
    }

    function testGetDelta_Uint() external {
        assertEq(stdMath.delta(uint256(0), uint256(0)), 0);
        assertEq(stdMath.delta(uint256(0), uint256(1337)), 1337);
        assertEq(stdMath.delta(uint256(0), type(uint64).max), type(uint64).max);
        assertEq(stdMath.delta(uint256(0), type(uint128).max), type(uint128).max);
        assertEq(stdMath.delta(uint256(0), type(uint256).max), type(uint256).max);

        assertEq(stdMath.delta(0, uint256(0)), 0);
        assertEq(stdMath.delta(1337, uint256(0)), 1337);
        assertEq(stdMath.delta(type(uint64).max, uint256(0)), type(uint64).max);
        assertEq(stdMath.delta(type(uint128).max, uint256(0)), type(uint128).max);
        assertEq(stdMath.delta(type(uint256).max, uint256(0)), type(uint256).max);

        assertEq(stdMath.delta(1337, uint256(1337)), 0);
        assertEq(stdMath.delta(type(uint256).max, type(uint256).max), 0);
        assertEq(stdMath.delta(5000, uint256(1250)), 3750);
    }

    function testGetDelta_Uint_Fuzz(uint256 a, uint256 b) external {
        uint256 manualDelta;
        if (a > b) {
            manualDelta = a - b;
        } else {
            manualDelta = b - a;
        }

        uint256 delta = stdMath.delta(a, b);

        assertEq(delta, manualDelta);
    }

    function testGetDelta_Int() external {
        assertEq(stdMath.delta(int256(0), int256(0)), 0);
        assertEq(stdMath.delta(int256(0), int256(1337)), 1337);
        assertEq(stdMath.delta(int256(0), type(int64).max), type(uint64).max >> 1);
        assertEq(stdMath.delta(int256(0), type(int128).max), type(uint128).max >> 1);
        assertEq(stdMath.delta(int256(0), type(int256).max), type(uint256).max >> 1);

        assertEq(stdMath.delta(0, int256(0)), 0);
        assertEq(stdMath.delta(1337, int256(0)), 1337);
        assertEq(stdMath.delta(type(int64).max, int256(0)), type(uint64).max >> 1);
        assertEq(stdMath.delta(type(int128).max, int256(0)), type(uint128).max >> 1);
        assertEq(stdMath.delta(type(int256).max, int256(0)), type(uint256).max >> 1);

        assertEq(stdMath.delta(-0, int256(0)), 0);
        assertEq(stdMath.delta(-1337, int256(0)), 1337);
        assertEq(stdMath.delta(type(int64).min, int256(0)), (type(uint64).max >> 1) + 1);
        assertEq(stdMath.delta(type(int128).min, int256(0)), (type(uint128).max >> 1) + 1);
        assertEq(stdMath.delta(type(int256).min, int256(0)), (type(uint256).max >> 1) + 1);

        assertEq(stdMath.delta(int256(0), -0), 0);
        assertEq(stdMath.delta(int256(0), -1337), 1337);
        assertEq(stdMath.delta(int256(0), type(int64).min), (type(uint64).max >> 1) + 1);
        assertEq(stdMath.delta(int256(0), type(int128).min), (type(uint128).max >> 1) + 1);
        assertEq(stdMath.delta(int256(0), type(int256).min), (type(uint256).max >> 1) + 1);

        assertEq(stdMath.delta(1337, int256(1337)), 0);
        assertEq(stdMath.delta(type(int256).max, type(int256).max), 0);
        assertEq(stdMath.delta(type(int256).min, type(int256).min), 0);
        assertEq(stdMath.delta(type(int256).min, type(int256).max), type(uint256).max);
        assertEq(stdMath.delta(5000, int256(1250)), 3750);
    }

    function testGetDelta_Int_Fuzz(int256 a, int256 b) external {
        uint256 absA = getAbs(a);
        uint256 absB = getAbs(b);
        uint256 absDelta = absA > absB ? absA - absB : absB - absA;

        uint256 manualDelta;
        if ((a >= 0 && b >= 0) || (a < 0 && b < 0)) {
            manualDelta = absDelta;
        }
        // (a < 0 && b >= 0) || (a >= 0 && b < 0)
        else {
            manualDelta = absA + absB;
        }

        uint256 delta = stdMath.delta(a, b);

        assertEq(delta, manualDelta);
    }

    function testGetPercentDelta_Uint() external {
        assertEq(stdMath.percentDelta(uint256(0), uint256(1337)), 1e18);
        assertEq(stdMath.percentDelta(uint256(0), type(uint64).max), 1e18);
        assertEq(stdMath.percentDelta(uint256(0), type(uint128).max), 1e18);
        assertEq(stdMath.percentDelta(uint256(0), type(uint192).max), 1e18);

        assertEq(stdMath.percentDelta(1337, uint256(1337)), 0);
        assertEq(stdMath.percentDelta(type(uint192).max, type(uint192).max), 0);
        assertEq(stdMath.percentDelta(0, uint256(2500)), 1e18);
        assertEq(stdMath.percentDelta(2500, uint256(2500)), 0);
        assertEq(stdMath.percentDelta(5000, uint256(2500)), 1e18);
        assertEq(stdMath.percentDelta(7500, uint256(2500)), 2e18);

        vm.expectRevert(stdError.divisionError);
        stdMath.percentDelta(uint256(1), 0);
    }

    function testGetPercentDelta_Uint_Fuzz(uint192 a, uint192 b) external {
        vm.assume(b != 0);
        uint256 manualDelta;
        if (a > b) {
            manualDelta = a - b;
        } else {
            manualDelta = b - a;
        }

        uint256 manualPercentDelta = manualDelta * 1e18 / b;
        uint256 percentDelta = stdMath.percentDelta(a, b);

        assertEq(percentDelta, manualPercentDelta);
    }

    function testGetPercentDelta_Int() external {
        assertEq(stdMath.percentDelta(int256(0), int256(1337)), 1e18);
        assertEq(stdMath.percentDelta(int256(0), -1337), 1e18);
        assertEq(stdMath.percentDelta(int256(0), type(int64).min), 1e18);
        assertEq(stdMath.percentDelta(int256(0), type(int128).min), 1e18);
        assertEq(stdMath.percentDelta(int256(0), type(int192).min), 1e18);
        assertEq(stdMath.percentDelta(int256(0), type(int64).max), 1e18);
        assertEq(stdMath.percentDelta(int256(0), type(int128).max), 1e18);
        assertEq(stdMath.percentDelta(int256(0), type(int192).max), 1e18);

        assertEq(stdMath.percentDelta(1337, int256(1337)), 0);
        assertEq(stdMath.percentDelta(type(int192).max, type(int192).max), 0);
        assertEq(stdMath.percentDelta(type(int192).min, type(int192).min), 0);

        assertEq(stdMath.percentDelta(type(int192).min, type(int192).max), 2e18); // rounds the 1 wei diff down
        assertEq(stdMath.percentDelta(type(int192).max, type(int192).min), 2e18 - 1); // rounds the 1 wei diff down
        assertEq(stdMath.percentDelta(0, int256(2500)), 1e18);
        assertEq(stdMath.percentDelta(2500, int256(2500)), 0);
        assertEq(stdMath.percentDelta(5000, int256(2500)), 1e18);
        assertEq(stdMath.percentDelta(7500, int256(2500)), 2e18);

        vm.expectRevert(stdError.divisionError);
        stdMath.percentDelta(int256(1), 0);
    }

    function testGetPercentDelta_Int_Fuzz(int192 a, int192 b) external {
        vm.assume(b != 0);
        uint256 absA = getAbs(a);
        uint256 absB = getAbs(b);
        uint256 absDelta = absA > absB ? absA - absB : absB - absA;

        uint256 manualDelta;
        if ((a >= 0 && b >= 0) || (a < 0 && b < 0)) {
            manualDelta = absDelta;
        }
        // (a < 0 && b >= 0) || (a >= 0 && b < 0)
        else {
            manualDelta = absA + absB;
        }

        uint256 manualPercentDelta = manualDelta * 1e18 / absB;
        uint256 percentDelta = stdMath.percentDelta(a, b);

        assertEq(percentDelta, manualPercentDelta);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                   HELPERS
    //////////////////////////////////////////////////////////////////////////*/

    function getAbs(int256 a) private pure returns (uint256) {
        if (a < 0) {
            return a == type(int256).min ? uint256(type(int256).max) + 1 : uint256(-a);
        }

        return uint256(a);
    }
}
