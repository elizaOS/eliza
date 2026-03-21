// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.5.0;

import "../src/test.sol";

contract DemoTest is DSTest {
    function test_this() public pure {
        require(true);
    }
    function test_logs() public {
        emit log("-- log(string)");
        emit log("a string");

        emit log("-- log_named_uint(string, uint)");
        emit log_named_uint("uint", 512);

        emit log("-- log_named_int(string, int)");
        emit log_named_int("int", -512);

        emit log("-- log_named_address(string, address)");
        emit log_named_address("address", address(this));

        emit log("-- log_named_bytes32(string, bytes32)");
        emit log_named_bytes32("bytes32", "a string");

        emit log("-- log_named_bytes(string, bytes)");
        emit log_named_bytes("bytes", hex"cafefe");

        emit log("-- log_named_string(string, string)");
        emit log_named_string("string", "a string");

        emit log("-- log_named_decimal_uint(string, uint, uint)");
        emit log_named_decimal_uint("decimal uint", 1.0e18, 18);

        emit log("-- log_named_decimal_int(string, int, uint)");
        emit log_named_decimal_int("decimal int", -1.0e18, 18);
    }
    event log_old_named_uint(bytes32,uint);
    function test_old_logs() public {
        emit log_old_named_uint("key", 500);
        emit log_named_bytes32("bkey", "val");
    }
    function test_trace() public view {
        this.echo("string 1", "string 2");
    }
    function test_multiline() public {
        emit log("a multiline\\nstring");
        emit log("a multiline string");
        emit log_bytes("a string");
        emit log_bytes("a multiline\nstring");
        emit log_bytes("a multiline\\nstring");
        emit logs(hex"0000");
        emit log_named_bytes("0x0000", hex"0000");
        emit logs(hex"ff");
    }
    function echo(string memory s1, string memory s2) public pure
        returns (string memory, string memory)
    {
        return (s1, s2);
    }

    function prove_this(uint x) public {
        emit log_named_uint("sym x", x);
        assertGt(x + 1, 0);
    }

    function test_logn() public {
        assembly {
            log0(0x01, 0x02)
            log1(0x01, 0x02, 0x03)
            log2(0x01, 0x02, 0x03, 0x04)
            log3(0x01, 0x02, 0x03, 0x04, 0x05)
        }
    }

    event MyEvent(uint, uint indexed, uint, uint indexed);
    function test_events() public {
        emit MyEvent(1, 2, 3, 4);
    }

    function test_asserts() public {
        string memory err = "this test has failed!";
        emit log("## assertTrue(bool)\n");
        assertTrue(false);
        emit log("\n");
        assertTrue(false, err);

        emit log("\n## assertEq(address,address)\n");
        assertEq(address(this), msg.sender);
        emit log("\n");
        assertEq(address(this), msg.sender, err);

        emit log("\n## assertEq32(bytes32,bytes32)\n");
        assertEq32("bytes 1", "bytes 2");
        emit log("\n");
        assertEq32("bytes 1", "bytes 2", err);

        emit log("\n## assertEq(bytes32,bytes32)\n");
        assertEq32("bytes 1", "bytes 2");
        emit log("\n");
        assertEq32("bytes 1", "bytes 2", err);

        emit log("\n## assertEq(uint,uint)\n");
        assertEq(uint(0), 1);
        emit log("\n");
        assertEq(uint(0), 1, err);

        emit log("\n## assertEq(int,int)\n");
        assertEq(-1, -2);
        emit log("\n");
        assertEq(-1, -2, err);

        emit log("\n## assertEqDecimal(int,int,uint)\n");
        assertEqDecimal(-1.0e18, -1.1e18, 18);
        emit log("\n");
        assertEqDecimal(-1.0e18, -1.1e18, 18, err);

        emit log("\n## assertEqDecimal(uint,uint,uint)\n");
        assertEqDecimal(uint(1.0e18), 1.1e18, 18);
        emit log("\n");
        assertEqDecimal(uint(1.0e18), 1.1e18, 18, err);

        emit log("\n## assertGt(uint,uint)\n");
        assertGt(uint(0), 0);
        emit log("\n");
        assertGt(uint(0), 0, err);

        emit log("\n## assertGt(int,int)\n");
        assertGt(-1, -1);
        emit log("\n");
        assertGt(-1, -1, err);

        emit log("\n## assertGtDecimal(int,int,uint)\n");
        assertGtDecimal(-2.0e18, -1.1e18, 18);
        emit log("\n");
        assertGtDecimal(-2.0e18, -1.1e18, 18, err);

        emit log("\n## assertGtDecimal(uint,uint,uint)\n");
        assertGtDecimal(uint(1.0e18), 1.1e18, 18);
        emit log("\n");
        assertGtDecimal(uint(1.0e18), 1.1e18, 18, err);

        emit log("\n## assertGe(uint,uint)\n");
        assertGe(uint(0), 1);
        emit log("\n");
        assertGe(uint(0), 1, err);

        emit log("\n## assertGe(int,int)\n");
        assertGe(-1, 0);
        emit log("\n");
        assertGe(-1, 0, err);

        emit log("\n## assertGeDecimal(int,int,uint)\n");
        assertGeDecimal(-2.0e18, -1.1e18, 18);
        emit log("\n");
        assertGeDecimal(-2.0e18, -1.1e18, 18, err);

        emit log("\n## assertGeDecimal(uint,uint,uint)\n");
        assertGeDecimal(uint(1.0e18), 1.1e18, 18);
        emit log("\n");
        assertGeDecimal(uint(1.0e18), 1.1e18, 18, err);

        emit log("\n## assertLt(uint,uint)\n");
        assertLt(uint(0), 0);
        emit log("\n");
        assertLt(uint(0), 0, err);

        emit log("\n## assertLt(int,int)\n");
        assertLt(-1, -1);
        emit log("\n");
        assertLt(-1, -1, err);

        emit log("\n## assertLtDecimal(int,int,uint)\n");
        assertLtDecimal(-1.0e18, -1.1e18, 18);
        emit log("\n");
        assertLtDecimal(-1.0e18, -1.1e18, 18, err);

        emit log("\n## assertLtDecimal(uint,uint,uint)\n");
        assertLtDecimal(uint(2.0e18), 1.1e18, 18);
        emit log("\n");
        assertLtDecimal(uint(2.0e18), 1.1e18, 18, err);

        emit log("\n## assertLe(uint,uint)\n");
        assertLe(uint(1), 0);
        emit log("\n");
        assertLe(uint(1), 0, err);

        emit log("\n## assertLe(int,int)\n");
        assertLe(0, -1);
        emit log("\n");
        assertLe(0, -1, err);

        emit log("\n## assertLeDecimal(int,int,uint)\n");
        assertLeDecimal(-1.0e18, -1.1e18, 18);
        emit log("\n");
        assertLeDecimal(-1.0e18, -1.1e18, 18, err);

        emit log("\n## assertLeDecimal(uint,uint,uint)\n");
        assertLeDecimal(uint(2.0e18), 1.1e18, 18);
        emit log("\n");
        assertLeDecimal(uint(2.0e18), 1.1e18, 18, err);

        emit log("\n## assertEq(string,string)\n");
        string memory s1 = "string 1";
        string memory s2 = "string 2";
        assertEq(s1, s2);
        emit log("\n");
        assertEq(s1, s2, err);

        emit log("\n## assertEq0(bytes,bytes)\n");
        assertEq0(hex"abcdef01", hex"abcdef02");
        emit log("\n");
        assertEq0(hex"abcdef01", hex"abcdef02", err);
    }
}

contract DemoTestWithSetUp {
    function setUp() public {
    }
    function test_pass() public pure {
    }
}
