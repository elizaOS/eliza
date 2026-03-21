// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Vm} from "./Vm.sol";

struct StdStorage {
    mapping(address => mapping(bytes4 => mapping(bytes32 => uint256))) slots;
    mapping(address => mapping(bytes4 => mapping(bytes32 => bool))) finds;
    bytes32[] _keys;
    bytes4 _sig;
    uint256 _depth;
    address _target;
    bytes32 _set;
}

library stdStorageSafe {
    event SlotFound(address who, bytes4 fsig, bytes32 keysHash, uint256 slot);
    event WARNING_UninitedSlot(address who, uint256 slot);

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function sigs(string memory sigStr) internal pure returns (bytes4) {
        return bytes4(keccak256(bytes(sigStr)));
    }

    /// @notice find an arbitrary storage slot given a function sig, input data, address of the contract and a value to check against
    // slot complexity:
    //  if flat, will be bytes32(uint256(uint));
    //  if map, will be keccak256(abi.encode(key, uint(slot)));
    //  if deep map, will be keccak256(abi.encode(key1, keccak256(abi.encode(key0, uint(slot)))));
    //  if map struct, will be bytes32(uint256(keccak256(abi.encode(key1, keccak256(abi.encode(key0, uint(slot)))))) + structFieldDepth);
    function find(StdStorage storage self) internal returns (uint256) {
        address who = self._target;
        bytes4 fsig = self._sig;
        uint256 field_depth = self._depth;
        bytes32[] memory ins = self._keys;

        // calldata to test against
        if (self.finds[who][fsig][keccak256(abi.encodePacked(ins, field_depth))]) {
            return self.slots[who][fsig][keccak256(abi.encodePacked(ins, field_depth))];
        }
        bytes memory cald = abi.encodePacked(fsig, flatten(ins));
        vm.record();
        bytes32 fdat;
        {
            (, bytes memory rdat) = who.staticcall(cald);
            fdat = bytesToBytes32(rdat, 32 * field_depth);
        }

        (bytes32[] memory reads,) = vm.accesses(address(who));
        if (reads.length == 1) {
            bytes32 curr = vm.load(who, reads[0]);
            if (curr == bytes32(0)) {
                emit WARNING_UninitedSlot(who, uint256(reads[0]));
            }
            if (fdat != curr) {
                require(
                    false,
                    "stdStorage find(StdStorage): Packed slot. This would cause dangerous overwriting and currently isn't supported."
                );
            }
            emit SlotFound(who, fsig, keccak256(abi.encodePacked(ins, field_depth)), uint256(reads[0]));
            self.slots[who][fsig][keccak256(abi.encodePacked(ins, field_depth))] = uint256(reads[0]);
            self.finds[who][fsig][keccak256(abi.encodePacked(ins, field_depth))] = true;
        } else if (reads.length > 1) {
            for (uint256 i = 0; i < reads.length; i++) {
                bytes32 prev = vm.load(who, reads[i]);
                if (prev == bytes32(0)) {
                    emit WARNING_UninitedSlot(who, uint256(reads[i]));
                }
                // store
                vm.store(who, reads[i], bytes32(hex"1337"));
                bool success;
                bytes memory rdat;
                {
                    (success, rdat) = who.staticcall(cald);
                    fdat = bytesToBytes32(rdat, 32 * field_depth);
                }

                if (success && fdat == bytes32(hex"1337")) {
                    // we found which of the slots is the actual one
                    emit SlotFound(who, fsig, keccak256(abi.encodePacked(ins, field_depth)), uint256(reads[i]));
                    self.slots[who][fsig][keccak256(abi.encodePacked(ins, field_depth))] = uint256(reads[i]);
                    self.finds[who][fsig][keccak256(abi.encodePacked(ins, field_depth))] = true;
                    vm.store(who, reads[i], prev);
                    break;
                }
                vm.store(who, reads[i], prev);
            }
        } else {
            revert("stdStorage find(StdStorage): No storage use detected for target.");
        }

        require(
            self.finds[who][fsig][keccak256(abi.encodePacked(ins, field_depth))],
            "stdStorage find(StdStorage): Slot(s) not found."
        );

        delete self._target;
        delete self._sig;
        delete self._keys;
        delete self._depth;

        return self.slots[who][fsig][keccak256(abi.encodePacked(ins, field_depth))];
    }

    function target(StdStorage storage self, address _target) internal returns (StdStorage storage) {
        self._target = _target;
        return self;
    }

    function sig(StdStorage storage self, bytes4 _sig) internal returns (StdStorage storage) {
        self._sig = _sig;
        return self;
    }

    function sig(StdStorage storage self, string memory _sig) internal returns (StdStorage storage) {
        self._sig = sigs(_sig);
        return self;
    }

    function with_key(StdStorage storage self, address who) internal returns (StdStorage storage) {
        self._keys.push(bytes32(uint256(uint160(who))));
        return self;
    }

    function with_key(StdStorage storage self, uint256 amt) internal returns (StdStorage storage) {
        self._keys.push(bytes32(amt));
        return self;
    }

    function with_key(StdStorage storage self, bytes32 key) internal returns (StdStorage storage) {
        self._keys.push(key);
        return self;
    }

    function depth(StdStorage storage self, uint256 _depth) internal returns (StdStorage storage) {
        self._depth = _depth;
        return self;
    }

    function read(StdStorage storage self) private returns (bytes memory) {
        address t = self._target;
        uint256 s = find(self);
        return abi.encode(vm.load(t, bytes32(s)));
    }

    function read_bytes32(StdStorage storage self) internal returns (bytes32) {
        return abi.decode(read(self), (bytes32));
    }

    function read_bool(StdStorage storage self) internal returns (bool) {
        int256 v = read_int(self);
        if (v == 0) return false;
        if (v == 1) return true;
        revert("stdStorage read_bool(StdStorage): Cannot decode. Make sure you are reading a bool.");
    }

    function read_address(StdStorage storage self) internal returns (address) {
        return abi.decode(read(self), (address));
    }

    function read_uint(StdStorage storage self) internal returns (uint256) {
        return abi.decode(read(self), (uint256));
    }

    function read_int(StdStorage storage self) internal returns (int256) {
        return abi.decode(read(self), (int256));
    }

    function bytesToBytes32(bytes memory b, uint256 offset) private pure returns (bytes32) {
        bytes32 out;

        uint256 max = b.length > 32 ? 32 : b.length;
        for (uint256 i = 0; i < max; i++) {
            out |= bytes32(b[offset + i] & 0xFF) >> (i * 8);
        }
        return out;
    }

    function flatten(bytes32[] memory b) private pure returns (bytes memory) {
        bytes memory result = new bytes(b.length * 32);
        for (uint256 i = 0; i < b.length; i++) {
            bytes32 k = b[i];
            /// @solidity memory-safe-assembly
            assembly {
                mstore(add(result, add(32, mul(32, i))), k)
            }
        }

        return result;
    }
}

library stdStorage {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function sigs(string memory sigStr) internal pure returns (bytes4) {
        return stdStorageSafe.sigs(sigStr);
    }

    function find(StdStorage storage self) internal returns (uint256) {
        return stdStorageSafe.find(self);
    }

    function target(StdStorage storage self, address _target) internal returns (StdStorage storage) {
        return stdStorageSafe.target(self, _target);
    }

    function sig(StdStorage storage self, bytes4 _sig) internal returns (StdStorage storage) {
        return stdStorageSafe.sig(self, _sig);
    }

    function sig(StdStorage storage self, string memory _sig) internal returns (StdStorage storage) {
        return stdStorageSafe.sig(self, _sig);
    }

    function with_key(StdStorage storage self, address who) internal returns (StdStorage storage) {
        return stdStorageSafe.with_key(self, who);
    }

    function with_key(StdStorage storage self, uint256 amt) internal returns (StdStorage storage) {
        return stdStorageSafe.with_key(self, amt);
    }

    function with_key(StdStorage storage self, bytes32 key) internal returns (StdStorage storage) {
        return stdStorageSafe.with_key(self, key);
    }

    function depth(StdStorage storage self, uint256 _depth) internal returns (StdStorage storage) {
        return stdStorageSafe.depth(self, _depth);
    }

    function checked_write(StdStorage storage self, address who) internal {
        checked_write(self, bytes32(uint256(uint160(who))));
    }

    function checked_write(StdStorage storage self, uint256 amt) internal {
        checked_write(self, bytes32(amt));
    }

    function checked_write(StdStorage storage self, bool write) internal {
        bytes32 t;
        /// @solidity memory-safe-assembly
        assembly {
            t := write
        }
        checked_write(self, t);
    }

    function checked_write(StdStorage storage self, bytes32 set) internal {
        address who = self._target;
        bytes4 fsig = self._sig;
        uint256 field_depth = self._depth;
        bytes32[] memory ins = self._keys;

        bytes memory cald = abi.encodePacked(fsig, flatten(ins));
        if (!self.finds[who][fsig][keccak256(abi.encodePacked(ins, field_depth))]) {
            find(self);
        }
        bytes32 slot = bytes32(self.slots[who][fsig][keccak256(abi.encodePacked(ins, field_depth))]);

        bytes32 fdat;
        {
            (, bytes memory rdat) = who.staticcall(cald);
            fdat = bytesToBytes32(rdat, 32 * field_depth);
        }
        bytes32 curr = vm.load(who, slot);

        if (fdat != curr) {
            require(
                false,
                "stdStorage find(StdStorage): Packed slot. This would cause dangerous overwriting and currently isn't supported."
            );
        }
        vm.store(who, slot, set);
        delete self._target;
        delete self._sig;
        delete self._keys;
        delete self._depth;
    }

    function read_bytes32(StdStorage storage self) internal returns (bytes32) {
        return stdStorageSafe.read_bytes32(self);
    }

    function read_bool(StdStorage storage self) internal returns (bool) {
        return stdStorageSafe.read_bool(self);
    }

    function read_address(StdStorage storage self) internal returns (address) {
        return stdStorageSafe.read_address(self);
    }

    function read_uint(StdStorage storage self) internal returns (uint256) {
        return stdStorageSafe.read_uint(self);
    }

    function read_int(StdStorage storage self) internal returns (int256) {
        return stdStorageSafe.read_int(self);
    }

    // Private function so needs to be copied over
    function bytesToBytes32(bytes memory b, uint256 offset) private pure returns (bytes32) {
        bytes32 out;

        uint256 max = b.length > 32 ? 32 : b.length;
        for (uint256 i = 0; i < max; i++) {
            out |= bytes32(b[offset + i] & 0xFF) >> (i * 8);
        }
        return out;
    }

    // Private function so needs to be copied over
    function flatten(bytes32[] memory b) private pure returns (bytes memory) {
        bytes memory result = new bytes(b.length * 32);
        for (uint256 i = 0; i < b.length; i++) {
            bytes32 k = b[i];
            /// @solidity memory-safe-assembly
            assembly {
                mstore(add(result, add(32, mul(32, i))), k)
            }
        }

        return result;
    }
}
