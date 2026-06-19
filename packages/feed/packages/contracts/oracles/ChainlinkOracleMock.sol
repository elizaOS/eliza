// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ChainlinkOracleMock
/// @notice Mock Chainlink oracle for testing prediction market resolution
/// @dev Simulates Chainlink AnyAPI request-response pattern
contract ChainlinkOracleMock is Ownable {
    struct Request {
        address requester;
        bytes32 marketId;
        string question;
        uint256 requestedAt;
        bool fulfilled;
    }

    mapping(bytes32 => Request) public requests;
    mapping(bytes32 => uint8) public results; // requestId => outcome

    uint256 private nonce = 0;
    uint256 public fee = 0.1 ether; // Fee per request

    event RequestCreated(bytes32 indexed requestId, bytes32 indexed marketId, address indexed requester);
    event RequestFulfilled(bytes32 indexed requestId, uint8 outcome);

    constructor() Ownable(msg.sender) {}

    /// @notice Request oracle resolution for a market
    /// @param _marketId Market identifier
    /// @param _question Market question for resolution
    /// @return requestId The request identifier
    function requestResolution(
        bytes32 _marketId,
        string calldata _question
    ) external payable returns (bytes32 requestId) {
        require(msg.value >= fee, "Insufficient fee");

        requestId = keccak256(abi.encodePacked(block.timestamp, msg.sender, nonce++));

        requests[requestId] = Request({
            requester: msg.sender,
            marketId: _marketId,
            question: _question,
            requestedAt: block.timestamp,
            fulfilled: false
        });

        emit RequestCreated(requestId, _marketId, msg.sender);

        // Return excess payment
        if (msg.value > fee) {
            (bool success, ) = msg.sender.call{value: msg.value - fee}("");
            require(success, "Refund failed");
        }
    }

    /// @notice Fulfill oracle request (owner only, simulates Chainlink node)
    /// @param _requestId Request to fulfill
    /// @param _outcome The resolved outcome
    function fulfillRequest(bytes32 _requestId, uint8 _outcome) external onlyOwner {
        Request storage request = requests[_requestId];
        require(!request.fulfilled, "Already fulfilled");
        require(request.requester != address(0), "Request not found");

        request.fulfilled = true;
        results[_requestId] = _outcome;

        emit RequestFulfilled(_requestId, _outcome);

        // Call back to requester
        (bool success, ) = request.requester.call(
            abi.encodeWithSignature(
                "oracleCallback(bytes32,bytes32,uint8)",
                _requestId,
                request.marketId,
                _outcome
            )
        );
        require(success, "Callback failed");
    }

    /// @notice Get request details
    function getRequest(bytes32 _requestId) external view returns (
        address requester,
        bytes32 marketId,
        string memory question,
        uint256 requestedAt,
        bool fulfilled
    ) {
        Request storage request = requests[_requestId];
        return (
            request.requester,
            request.marketId,
            request.question,
            request.requestedAt,
            request.fulfilled
        );
    }

    /// @notice Get result for fulfilled request
    function getResult(bytes32 _requestId) external view returns (uint8) {
        require(requests[_requestId].fulfilled, "Not fulfilled");
        return results[_requestId];
    }

    /// @notice Update oracle fee (owner only)
    event FeeUpdated(uint256 oldFee, uint256 newFee);

    function setFee(uint256 _fee) external onlyOwner {
        uint256 oldFee = fee;
        fee = _fee;
        emit FeeUpdated(oldFee, _fee);
    }

    /// @notice Withdraw accumulated fees (owner only)
    function withdraw() external onlyOwner {
        (bool success, ) = owner().call{value: address(this).balance}("");
        require(success, "Withdrawal failed");
    }

    receive() external payable {}
}
