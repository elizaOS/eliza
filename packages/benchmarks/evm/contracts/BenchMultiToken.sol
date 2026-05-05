// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BenchMultiToken {
    mapping(uint256 => mapping(address => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);

    function uri(uint256) external pure returns (string memory) {
        return "https://bench.test/multi/{id}";
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0xd9b67a26 || interfaceId == 0x01ffc9a7;
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory) {
        require(accounts.length == ids.length, "length mismatch");
        uint256[] memory bals = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            bals[i] = balanceOf[ids[i]][accounts[i]];
        }
        return bals;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "not authorized");
        require(balanceOf[id][from] >= amount, "insufficient balance");
        balanceOf[id][from] -= amount;
        balanceOf[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "not authorized");
        require(ids.length == amounts.length, "length mismatch");
        for (uint256 i = 0; i < ids.length; i++) {
            require(balanceOf[ids[i]][from] >= amounts[i], "insufficient balance");
            balanceOf[ids[i]][from] -= amounts[i];
            balanceOf[ids[i]][to] += amounts[i];
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
    }

    function mint(address to, uint256 id, uint256 amount, bytes calldata) external {
        balanceOf[id][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
    }
}
