// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {LibMarket} from "../libraries/LibMarket.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/// @title ReferralSystemFacet
/// @notice Facet for referral tracking and rewards
/// @dev Implements multi-tier referral system with commission tracking
contract ReferralSystemFacet is ReentrancyGuard {
    bytes32 constant REFERRAL_STORAGE_POSITION = keccak256("polyagent.referral.storage");

    struct ReferralData {
        address referrer; // Who referred this user
        uint256 referredCount; // How many users this address has referred
        uint256 totalEarned; // Total referral earnings
        uint256 tier; // Referral tier (0-3)
        uint256 registeredAt;
        bool isActive;
    }

    struct ReferralStorage {
        mapping(address => ReferralData) referrals;
        mapping(uint256 => uint256) tierRates; // tier => commission rate (basis points)
        uint256 defaultTier;
        uint256 tier1Threshold; // Referrals needed for tier 1
        uint256 tier2Threshold; // Referrals needed for tier 2
        uint256 tier3Threshold; // Referrals needed for tier 3
        address referralTreasury;
        uint256 totalReferralsRegistered;
        uint256 totalCommissionsPaid;
    }

    event ReferralRegistered(address indexed user, address indexed referrer);
    event ReferralCommissionPaid(address indexed referrer, address indexed user, uint256 amount, uint256 tier);
    event TierUpgraded(address indexed referrer, uint256 newTier);
    event CommissionClaimed(address indexed referrer, uint256 amount);

    function referralStorage() internal pure returns (ReferralStorage storage rs) {
        bytes32 position = REFERRAL_STORAGE_POSITION;
        assembly {
            rs.slot := position
        }
    }

    /// @notice Register a referral relationship
    function registerReferral(address _referrer) external {
        require(_referrer != address(0), "Invalid referrer");
        require(_referrer != msg.sender, "Cannot refer yourself");

        ReferralStorage storage rs = referralStorage();
        ReferralData storage userData = rs.referrals[msg.sender];

        require(userData.referrer == address(0), "Already registered");

        // Register referral
        userData.referrer = _referrer;
        userData.registeredAt = block.timestamp;
        userData.isActive = true;
        userData.tier = rs.defaultTier;

        // Update referrer stats
        ReferralData storage referrerData = rs.referrals[_referrer];
        referrerData.referredCount += 1;
        referrerData.isActive = true;

        // Auto-upgrade referrer tier if thresholds met
        _checkAndUpgradeTier(_referrer);

        rs.totalReferralsRegistered += 1;

        emit ReferralRegistered(msg.sender, _referrer);
    }

    /// @notice Pay referral commission from caller's balance
    /// @dev Deducts commission from msg.sender's balance - caller must have sufficient funds
    /// @dev This ensures commissions are properly funded and prevents exploitation
    /// @param _user The user who made the transaction
    /// @param _transactionAmount The transaction amount to calculate commission on
    function payReferralCommission(
        address _user,
        uint256 _transactionAmount
    ) external returns (uint256 commission) {
        ReferralStorage storage rs = referralStorage();
        ReferralData storage userData = rs.referrals[_user];

        if (userData.referrer == address(0) || !userData.isActive) {
            return 0;
        }

        address referrer = userData.referrer;
        ReferralData storage referrerData = rs.referrals[referrer];

        // Calculate commission based on referrer's tier
        uint256 commissionRate = rs.tierRates[referrerData.tier];
        commission = (_transactionAmount * commissionRate) / 10000;

        if (commission > 0) {
            // Deduct commission from caller's balance (prevents free commission exploit)
            LibMarket.subtractBalance(msg.sender, commission);
            
            // Add commission to referrer's balance
            LibMarket.addBalance(referrer, commission);

            // Update referrer stats
            referrerData.totalEarned += commission;

            // Update global stats
            rs.totalCommissionsPaid += commission;

            emit ReferralCommissionPaid(referrer, _user, commission, referrerData.tier);
        }
    }

    /// @notice Claim accumulated referral earnings
    function claimReferralEarnings() external nonReentrant {
        uint256 balance = LibMarket.getBalance(msg.sender);
        require(balance > 0, "No earnings to claim");

        // Transfer earnings to referrer (balance is already in LibMarket)
        // This function is mainly for event emission and additional logic if needed

        emit CommissionClaimed(msg.sender, balance);
    }

    /// @notice Check and upgrade referrer tier
    function _checkAndUpgradeTier(address _referrer) internal {
        ReferralStorage storage rs = referralStorage();
        ReferralData storage referrerData = rs.referrals[_referrer];

        uint256 currentTier = referrerData.tier;
        uint256 newTier = currentTier;

        if (referrerData.referredCount >= rs.tier3Threshold) {
            newTier = 3;
        } else if (referrerData.referredCount >= rs.tier2Threshold) {
            newTier = 2;
        } else if (referrerData.referredCount >= rs.tier1Threshold) {
            newTier = 1;
        }

        if (newTier > currentTier) {
            referrerData.tier = newTier;
            emit TierUpgraded(_referrer, newTier);
        }
    }

    /// @notice Initialize referral system (called once by admin)
    function initializeReferralSystem(
        uint256 _tier0Rate,
        uint256 _tier1Rate,
        uint256 _tier2Rate,
        uint256 _tier3Rate,
        uint256 _tier1Threshold,
        uint256 _tier2Threshold,
        uint256 _tier3Threshold
    ) external {
        LibDiamond.enforceIsContractOwner();

        ReferralStorage storage rs = referralStorage();

        rs.tierRates[0] = _tier0Rate;
        rs.tierRates[1] = _tier1Rate;
        rs.tierRates[2] = _tier2Rate;
        rs.tierRates[3] = _tier3Rate;

        rs.tier1Threshold = _tier1Threshold;
        rs.tier2Threshold = _tier2Threshold;
        rs.tier3Threshold = _tier3Threshold;

        rs.defaultTier = 0;
    }

    /// @notice Get referral data for a user
    function getReferralData(address _user)
        external
        view
        returns (
            address referrer,
            uint256 referredCount,
            uint256 totalEarned,
            uint256 tier,
            uint256 registeredAt,
            bool isActive
        )
    {
        ReferralStorage storage rs = referralStorage();
        ReferralData storage data = rs.referrals[_user];

        return (
            data.referrer,
            data.referredCount,
            data.totalEarned,
            data.tier,
            data.registeredAt,
            data.isActive
        );
    }

    /// @notice Get tier information
    function getTierInfo(uint256 _tier)
        external
        view
        returns (
            uint256 commissionRate,
            uint256 threshold
        )
    {
        ReferralStorage storage rs = referralStorage();

        commissionRate = rs.tierRates[_tier];

        if (_tier == 1) {
            threshold = rs.tier1Threshold;
        } else if (_tier == 2) {
            threshold = rs.tier2Threshold;
        } else if (_tier == 3) {
            threshold = rs.tier3Threshold;
        }
    }

    /// @notice Get referral chain (up to 3 levels)
    function getReferralChain(address _user)
        external
        view
        returns (address[] memory)
    {
        ReferralStorage storage rs = referralStorage();
        address[] memory chain = new address[](3);

        chain[0] = rs.referrals[_user].referrer;
        if (chain[0] != address(0)) {
            chain[1] = rs.referrals[chain[0]].referrer;
            if (chain[1] != address(0)) {
                chain[2] = rs.referrals[chain[1]].referrer;
            }
        }

        return chain;
    }

    /// @notice Get total referral stats
    function getTotalStats()
        external
        view
        returns (
            uint256 totalReferrals,
            uint256 totalCommissions
        )
    {
        ReferralStorage storage rs = referralStorage();
        return (
            rs.totalReferralsRegistered,
            rs.totalCommissionsPaid
        );
    }

    /// @notice Get total number of referrals
    function getTotalReferrals() external view returns (uint256) {
        ReferralStorage storage rs = referralStorage();
        return rs.totalReferralsRegistered;
    }

    /// @notice Get total commissions paid
    function getTotalCommissions() external view returns (uint256) {
        ReferralStorage storage rs = referralStorage();
        return rs.totalCommissionsPaid;
    }

    /// @notice Check if user is referred
    function isReferred(address _user) external view returns (bool) {
        ReferralStorage storage rs = referralStorage();
        return rs.referrals[_user].referrer != address(0);
    }

    /// @notice Calculate potential commission for an amount
    function calculateCommission(address _referrer, uint256 _amount)
        external
        view
        returns (uint256)
    {
        ReferralStorage storage rs = referralStorage();
        ReferralData storage referrerData = rs.referrals[_referrer];

        uint256 commissionRate = rs.tierRates[referrerData.tier];
        return (_amount * commissionRate) / 10000;
    }
}
