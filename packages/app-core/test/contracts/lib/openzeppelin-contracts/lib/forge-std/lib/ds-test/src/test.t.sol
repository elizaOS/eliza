// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.5.0;

import {DSTest} from "./test.sol";

contract DemoTest is DSTest {

    // --- assertTrue ---

    function testAssertTrue() public {
        assertTrue(true, "msg");
        assertTrue(true);
    }
    function testFailAssertTrue() public {
        assertTrue(false);
    }
    function testFailAssertTrueWithMsg() public {
        assertTrue(false, "msg");
    }

    // --- assertEq (Addr) ---

    function testAssertEqAddr() public {
        assertEq(address(0x0), address(0x0), "msg");
        assertEq(address(0x0), address(0x0));
    }
    function testFailAssertEqAddr() public {
        assertEq(address(0x0), address(0x1));
    }
    function testFailAssertEqAddrWithMsg() public {
        assertEq(address(0x0), address(0x1), "msg");
    }

    // --- assertEq (Bytes32) ---

    function testAssertEqBytes32() public {
        assertEq(bytes32("hi"), bytes32("hi"), "msg");
        assertEq(bytes32("hi"), bytes32("hi"));
    }
    function testFailAssertEqBytes32() public {
        assertEq(bytes32("hi"), bytes32("ho"));
    }
    function testFailAssertEqBytes32WithMsg() public {
        assertEq(bytes32("hi"), bytes32("ho"), "msg");
    }

    // --- assertEq (Int) ---

    function testAssertEqInt() public {
        assertEq(-1, -1, "msg");
        assertEq(-1, -1);
    }
    function testFailAssertEqInt() public {
        assertEq(-1, -2);
    }
    function testFailAssertEqIntWithMsg() public {
        assertEq(-1, -2, "msg");
    }

    // --- assertEq (UInt) ---

    function testAssertEqUInt() public {
        assertEq(uint(1), uint(1), "msg");
        assertEq(uint(1), uint(1));
    }
    function testFailAssertEqUInt() public {
        assertEq(uint(1), uint(2));
    }
    function testFailAssertEqUIntWithMsg() public {
        assertEq(uint(1), uint(2), "msg");
    }

    // --- assertEqDecimal (Int) ---

    function testAssertEqDecimalInt() public {
        assertEqDecimal(-1, -1, 18, "msg");
        assertEqDecimal(-1, -1, 18);
    }
    function testFailAssertEqDecimalInt() public {
        assertEqDecimal(-1, -2, 18);
    }
    function testFailAssertEqDecimalIntWithMsg() public {
        assertEqDecimal(-1, -2, 18, "msg");
    }

    // --- assertEqDecimal (UInt) ---

    function testAssertEqDecimalUInt() public {
        assertEqDecimal(uint(1), uint(1), 18, "msg");
        assertEqDecimal(uint(1), uint(1), 18);
    }
    function testFailAssertEqDecimalUInt() public {
        assertEqDecimal(uint(1), uint(2), 18);
    }
    function testFailAssertEqDecimalUIntWithMsg() public {
        assertEqDecimal(uint(1), uint(2), 18, "msg");
    }

    // --- assertGt (UInt) ---

    function testAssertGtUInt() public {
        assertGt(uint(2), uint(1), "msg");
        assertGt(uint(3), uint(2));
    }
    function testFailAssertGtUInt() public {
        assertGt(uint(1), uint(2));
    }
    function testFailAssertGtUIntWithMsg() public {
        assertGt(uint(1), uint(2), "msg");
    }

    // --- assertGt (Int) ---

    function testAssertGtInt() public {
        assertGt(-1, -2, "msg");
        assertGt(-1, -3);
    }
    function testFailAssertGtInt() public {
        assertGt(-2, -1);
    }
    function testFailAssertGtIntWithMsg() public {
        assertGt(-2, -1, "msg");
    }

    // --- assertGtDecimal (UInt) ---

    function testAssertGtDecimalUInt() public {
        assertGtDecimal(uint(2), uint(1), 18, "msg");
        assertGtDecimal(uint(3), uint(2), 18);
    }
    function testFailAssertGtDecimalUInt() public {
        assertGtDecimal(uint(1), uint(2), 18);
    }
    function testFailAssertGtDecimalUIntWithMsg() public {
        assertGtDecimal(uint(1), uint(2), 18, "msg");
    }

    // --- assertGtDecimal (Int) ---

    function testAssertGtDecimalInt() public {
        assertGtDecimal(-1, -2, 18, "msg");
        assertGtDecimal(-1, -3, 18);
    }
    function testFailAssertGtDecimalInt() public {
        assertGtDecimal(-2, -1, 18);
    }
    function testFailAssertGtDecimalIntWithMsg() public {
        assertGtDecimal(-2, -1, 18, "msg");
    }

    // --- assertGe (UInt) ---

    function testAssertGeUInt() public {
        assertGe(uint(2), uint(1), "msg");
        assertGe(uint(2), uint(2));
    }
    function testFailAssertGeUInt() public {
        assertGe(uint(1), uint(2));
    }
    function testFailAssertGeUIntWithMsg() public {
        assertGe(uint(1), uint(2), "msg");
    }

    // --- assertGe (Int) ---

    function testAssertGeInt() public {
        assertGe(-1, -2, "msg");
        assertGe(-1, -1);
    }
    function testFailAssertGeInt() public {
        assertGe(-2, -1);
    }
    function testFailAssertGeIntWithMsg() public {
        assertGe(-2, -1, "msg");
    }

    // --- assertGeDecimal (UInt) ---

    function testAssertGeDecimalUInt() public {
        assertGeDecimal(uint(2), uint(1), 18, "msg");
        assertGeDecimal(uint(2), uint(2), 18);
    }
    function testFailAssertGeDecimalUInt() public {
        assertGeDecimal(uint(1), uint(2), 18);
    }
    function testFailAssertGeDecimalUIntWithMsg() public {
        assertGeDecimal(uint(1), uint(2), 18, "msg");
    }

    // --- assertGeDecimal (Int) ---

    function testAssertGeDecimalInt() public {
        assertGeDecimal(-1, -2, 18, "msg");
        assertGeDecimal(-1, -2, 18);
    }
    function testFailAssertGeDecimalInt() public {
        assertGeDecimal(-2, -1, 18);
    }
    function testFailAssertGeDecimalIntWithMsg() public {
        assertGeDecimal(-2, -1, 18, "msg");
    }

    // --- assertLt (UInt) ---

    function testAssertLtUInt() public {
        assertLt(uint(1), uint(2), "msg");
        assertLt(uint(1), uint(3));
    }
    function testFailAssertLtUInt() public {
        assertLt(uint(2), uint(2));
    }
    function testFailAssertLtUIntWithMsg() public {
        assertLt(uint(3), uint(2), "msg");
    }

    // --- assertLt (Int) ---

    function testAssertLtInt() public {
        assertLt(-2, -1, "msg");
        assertLt(-1, 0);
    }
    function testFailAssertLtInt() public {
        assertLt(-1, -2);
    }
    function testFailAssertLtIntWithMsg() public {
        assertLt(-1, -1, "msg");
    }

    // --- assertLtDecimal (UInt) ---

    function testAssertLtDecimalUInt() public {
        assertLtDecimal(uint(1), uint(2), 18, "msg");
        assertLtDecimal(uint(2), uint(3), 18);
    }
    function testFailAssertLtDecimalUInt() public {
        assertLtDecimal(uint(1), uint(1), 18);
    }
    function testFailAssertLtDecimalUIntWithMsg() public {
        assertLtDecimal(uint(2), uint(1), 18, "msg");
    }

    // --- assertLtDecimal (Int) ---

    function testAssertLtDecimalInt() public {
        assertLtDecimal(-2, -1, 18, "msg");
        assertLtDecimal(-2, -1, 18);
    }
    function testFailAssertLtDecimalInt() public {
        assertLtDecimal(-2, -2, 18);
    }
    function testFailAssertLtDecimalIntWithMsg() public {
        assertLtDecimal(-1, -2, 18, "msg");
    }

    // --- assertLe (UInt) ---

    function testAssertLeUInt() public {
        assertLe(uint(1), uint(2), "msg");
        assertLe(uint(1), uint(1));
    }
    function testFailAssertLeUInt() public {
        assertLe(uint(4), uint(2));
    }
    function testFailAssertLeUIntWithMsg() public {
        assertLe(uint(3), uint(2), "msg");
    }

    // --- assertLe (Int) ---

    function testAssertLeInt() public {
        assertLe(-2, -1, "msg");
        assertLe(-1, -1);
    }
    function testFailAssertLeInt() public {
        assertLe(-1, -2);
    }
    function testFailAssertLeIntWithMsg() public {
        assertLe(-1, -3, "msg");
    }

    // --- assertLeDecimal (UInt) ---

    function testAssertLeDecimalUInt() public {
        assertLeDecimal(uint(1), uint(2), 18, "msg");
        assertLeDecimal(uint(2), uint(2), 18);
    }
    function testFailAssertLeDecimalUInt() public {
        assertLeDecimal(uint(1), uint(0), 18);
    }
    function testFailAssertLeDecimalUIntWithMsg() public {
        assertLeDecimal(uint(1), uint(0), 18, "msg");
    }

    // --- assertLeDecimal (Int) ---

    function testAssertLeDecimalInt() public {
        assertLeDecimal(-2, -1, 18, "msg");
        assertLeDecimal(-2, -2, 18);
    }
    function testFailAssertLeDecimalInt() public {
        assertLeDecimal(-2, -3, 18);
    }
    function testFailAssertLeDecimalIntWithMsg() public {
        assertLeDecimal(-1, -2, 18, "msg");
    }

    // --- fail override ---

    // ensure that fail can be overridden
    function fail() internal override {
        super.fail();
    }
}
