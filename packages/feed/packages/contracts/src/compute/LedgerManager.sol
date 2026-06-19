// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import "./IComputeRegistry.sol";

/**
 * @title LedgerManager
 * @notice Manages user accounts and provider sub-accounts for compute payments
 * @dev Inspired by 0G's LedgerManager with per-provider sub-accounts
 */
contract LedgerManager is Ownable, ReentrancyGuard, Pausable {
    
    // ============ Structs ============
    
    struct Ledger {
        uint256 totalBalance;      // Total deposited
        uint256 availableBalance;  // Available for transfer
        uint256 lockedBalance;     // Locked in provider sub-accounts
        uint256 createdAt;
    }
    
    struct ProviderSubAccount {
        uint256 balance;           // Balance in this sub-account
        uint256 pendingRefund;     // Amount pending refund
        uint256 refundUnlockTime;  // When refund becomes available
        bool acknowledged;         // Provider has acknowledged signer
    }
    
    struct RefundRequest {
        uint256 amount;
        uint256 unlockTime;
    }
    
    // ============ Constants ============
    
    uint256 public constant MIN_DEPOSIT = 0.001 ether;
    uint256 public constant REFUND_LOCKUP = 24 hours;
    
    // ============ State Variables ============
    
    IComputeRegistry public immutable registry;
    
    mapping(address => Ledger) private _ledgers;
    mapping(address => mapping(address => ProviderSubAccount)) private _subAccounts;
    mapping(address => mapping(address => RefundRequest[])) private _refundRequests;
    
    // ============ Events ============
    
    event LedgerCreated(address indexed user, uint256 initialDeposit);
    event Deposited(address indexed user, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed user, uint256 amount, uint256 newBalance);
    event TransferredToProvider(
        address indexed user,
        address indexed provider,
        uint256 amount
    );
    event ProviderAcknowledged(address indexed user, address indexed provider);
    event RefundRequested(
        address indexed user,
        address indexed provider,
        uint256 amount,
        uint256 unlockTime
    );
    event RefundCompleted(
        address indexed user,
        address indexed provider,
        uint256 amount
    );
    event SettlementProcessed(
        address indexed user,
        address indexed provider,
        uint256 fee,
        uint256 inputTokens,
        uint256 outputTokens
    );
    
    // ============ Errors ============
    
    error LedgerNotExists();
    error LedgerAlreadyExists();
    error InsufficientBalance();
    error InsufficientDeposit();
    error ProviderNotRegistered();
    error ProviderNotAcknowledged();
    error RefundNotReady();
    error NoRefundPending();
    error InvalidAmount();
    
    // ============ Constructor ============
    
    constructor(address _registry, address _owner) Ownable(_owner) {
        registry = IComputeRegistry(_registry);
    }
    
    // ============ Ledger Management ============
    
    /**
     * @notice Create a ledger for the caller
     */
    function createLedger() external payable whenNotPaused {
        if (_ledgers[msg.sender].createdAt != 0) {
            revert LedgerAlreadyExists();
        }
        if (msg.value < MIN_DEPOSIT) {
            revert InsufficientDeposit();
        }
        
        _ledgers[msg.sender] = Ledger({
            totalBalance: msg.value,
            availableBalance: msg.value,
            lockedBalance: 0,
            createdAt: block.timestamp
        });
        
        emit LedgerCreated(msg.sender, msg.value);
    }
    
    /**
     * @notice Deposit funds to ledger
     */
    function deposit() external payable nonReentrant whenNotPaused {
        Ledger storage ledger = _ledgers[msg.sender];
        
        // Auto-create ledger if doesn't exist
        if (ledger.createdAt == 0) {
            if (msg.value < MIN_DEPOSIT) {
                revert InsufficientDeposit();
            }
            ledger.createdAt = block.timestamp;
            emit LedgerCreated(msg.sender, msg.value);
        }
        
        ledger.totalBalance += msg.value;
        ledger.availableBalance += msg.value;
        
        emit Deposited(msg.sender, msg.value, ledger.totalBalance);
    }
    
    /**
     * @notice Withdraw available funds
     */
    function withdraw(uint256 amount) external nonReentrant {
        Ledger storage ledger = _ledgers[msg.sender];
        if (ledger.createdAt == 0) {
            revert LedgerNotExists();
        }
        if (amount > ledger.availableBalance) {
            revert InsufficientBalance();
        }
        
        ledger.availableBalance -= amount;
        ledger.totalBalance -= amount;
        
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
        
        emit Withdrawn(msg.sender, amount, ledger.totalBalance);
    }
    
    // ============ Provider Sub-Accounts ============
    
    /**
     * @notice Transfer funds to a provider sub-account
     */
    function transferToProvider(
        address provider,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        Ledger storage ledger = _ledgers[msg.sender];
        if (ledger.createdAt == 0) {
            revert LedgerNotExists();
        }
        if (amount > ledger.availableBalance) {
            revert InsufficientBalance();
        }
        if (!registry.isActive(provider)) {
            revert ProviderNotRegistered();
        }
        
        ledger.availableBalance -= amount;
        ledger.lockedBalance += amount;
        
        _subAccounts[msg.sender][provider].balance += amount;
        
        emit TransferredToProvider(msg.sender, provider, amount);
    }
    
    /**
     * @notice Acknowledge provider's signer (required before first use)
     */
    function acknowledgeProvider(address provider) external whenNotPaused {
        if (_ledgers[msg.sender].createdAt == 0) {
            revert LedgerNotExists();
        }
        if (!registry.isActive(provider)) {
            revert ProviderNotRegistered();
        }
        
        _subAccounts[msg.sender][provider].acknowledged = true;
        
        emit ProviderAcknowledged(msg.sender, provider);
    }
    
    /**
     * @notice Request refund from provider sub-account
     * @dev Refund has 24-hour lockup period
     */
    function requestRefund(
        address provider,
        uint256 amount
    ) external nonReentrant {
        ProviderSubAccount storage subAccount = _subAccounts[msg.sender][provider];
        
        if (amount > subAccount.balance - subAccount.pendingRefund) {
            revert InsufficientBalance();
        }
        
        subAccount.pendingRefund += amount;
        uint256 unlockTime = block.timestamp + REFUND_LOCKUP;
        
        _refundRequests[msg.sender][provider].push(RefundRequest({
            amount: amount,
            unlockTime: unlockTime
        }));
        
        emit RefundRequested(msg.sender, provider, amount, unlockTime);
    }
    
    /**
     * @notice Complete pending refunds that have passed lockup
     */
    function completeRefund(address provider) external nonReentrant {
        Ledger storage ledger = _ledgers[msg.sender];
        ProviderSubAccount storage subAccount = _subAccounts[msg.sender][provider];
        RefundRequest[] storage requests = _refundRequests[msg.sender][provider];
        
        uint256 totalRefund = 0;
        uint256 i = 0;
        
        while (i < requests.length) {
            if (requests[i].unlockTime <= block.timestamp) {
                totalRefund += requests[i].amount;
                
                // Remove processed request
                requests[i] = requests[requests.length - 1];
                requests.pop();
            } else {
                i++;
            }
        }
        
        if (totalRefund == 0) {
            revert NoRefundPending();
        }
        
        subAccount.balance -= totalRefund;
        subAccount.pendingRefund -= totalRefund;
        ledger.lockedBalance -= totalRefund;
        ledger.availableBalance += totalRefund;
        
        emit RefundCompleted(msg.sender, provider, totalRefund);
    }
    
    // ============ Settlement (Called by InferenceServing) ============
    
    /// @notice Authorized inference contract
    address public inferenceContract;
    
    /**
     * @notice Set the authorized inference contract
     */
    event InferenceContractUpdated(address indexed oldContract, address indexed newContract);

    function setInferenceContract(address _inference) external onlyOwner {
        require(_inference != address(0), "Invalid inference contract");
        address old = inferenceContract;
        inferenceContract = _inference;
        emit InferenceContractUpdated(old, _inference);
    }
    
    /**
     * @notice Process settlement for inference request
     * @param user User who made the request
     * @param provider Provider who served the request
     * @param fee Total fee to charge
     * @param inputTokens Number of input tokens
     * @param outputTokens Number of output tokens
     */
    function processSettlement(
        address user,
        address provider,
        uint256 fee,
        uint256 inputTokens,
        uint256 outputTokens
    ) external {
        // Only callable by authorized contracts (InferenceServing, provider, or owner)
        require(
            msg.sender == inferenceContract || msg.sender == provider || msg.sender == owner(),
            "Unauthorized"
        );
        
        ProviderSubAccount storage subAccount = _subAccounts[user][provider];
        
        if (fee > subAccount.balance - subAccount.pendingRefund) {
            revert InsufficientBalance();
        }
        
        subAccount.balance -= fee;
        
        Ledger storage userLedger = _ledgers[user];
        userLedger.lockedBalance -= fee;
        userLedger.totalBalance -= fee;
        
        // Emit event BEFORE external call (CEI pattern)
        emit SettlementProcessed(user, provider, fee, inputTokens, outputTokens);
        
        // Transfer fee to provider
        (bool success, ) = provider.call{value: fee}("");
        require(success, "Transfer failed");
    }
    
    // ============ View Functions ============
    
    function getLedger(address user) external view returns (Ledger memory) {
        return _ledgers[user];
    }
    
    function getSubAccount(
        address user,
        address provider
    ) external view returns (ProviderSubAccount memory) {
        return _subAccounts[user][provider];
    }
    
    function getAvailableBalance(address user) external view returns (uint256) {
        return _ledgers[user].availableBalance;
    }
    
    function getProviderBalance(
        address user,
        address provider
    ) external view returns (uint256) {
        ProviderSubAccount storage sub = _subAccounts[user][provider];
        return sub.balance - sub.pendingRefund;
    }
    
    function isAcknowledged(
        address user,
        address provider
    ) external view returns (bool) {
        return _subAccounts[user][provider].acknowledged;
    }
    
    function getPendingRefunds(
        address user,
        address provider
    ) external view returns (RefundRequest[] memory) {
        return _refundRequests[user][provider];
    }
    
    function ledgerExists(address user) external view returns (bool) {
        return _ledgers[user].createdAt != 0;
    }
    
    // ============ Admin Functions ============
    
    function pause() external onlyOwner {
        _pause();
    }
    
    function unpause() external onlyOwner {
        _unpause();
    }
    
    function version() external pure returns (string memory) {
        return "1.0.0";
    }
}

