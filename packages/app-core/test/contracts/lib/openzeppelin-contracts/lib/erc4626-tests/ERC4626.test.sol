// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;

import "./ERC4626.prop.sol";

interface IMockERC20 is IERC20 {
    function mint(address to, uint value) external;
    function burn(address from, uint value) external;
}

abstract contract ERC4626Test is ERC4626Prop {
    function setUp() public virtual;

    uint constant N = 4;

    struct Init {
        address[N] user;
        uint[N] share;
        uint[N] asset;
        int yield;
    }

    // setup initial vault state as follows:
    //
    // totalAssets == sum(init.share) + init.yield
    // totalShares == sum(init.share)
    //
    // init.user[i]'s assets == init.asset[i]
    // init.user[i]'s shares == init.share[i]
    function setUpVault(Init memory init) public virtual {
        // setup initial shares and assets for individual users
        for (uint i = 0; i < N; i++) {
            address user = init.user[i];
            vm.assume(_isEOA(user));
            // shares
            uint shares = init.share[i];
            try IMockERC20(_underlying_).mint(user, shares) {} catch { vm.assume(false); }
            _approve(_underlying_, user, _vault_, shares);
            vm.prank(user); try IERC4626(_vault_).deposit(shares, user) {} catch { vm.assume(false); }
            // assets
            uint assets = init.asset[i];
            try IMockERC20(_underlying_).mint(user, assets) {} catch { vm.assume(false); }
        }

        // setup initial yield for vault
        setUpYield(init);
    }

    // setup initial yield
    function setUpYield(Init memory init) public virtual {
        if (init.yield >= 0) { // gain
            uint gain = uint(init.yield);
            try IMockERC20(_underlying_).mint(_vault_, gain) {} catch { vm.assume(false); } // this can be replaced by calling yield generating functions if provided by the vault
        } else { // loss
            vm.assume(init.yield > type(int).min); // avoid overflow in conversion
            uint loss = uint(-1 * init.yield);
            try IMockERC20(_underlying_).burn(_vault_, loss) {} catch { vm.assume(false); } // this can be replaced by calling yield generating functions if provided by the vault
        }
    }

    //
    // asset
    //

    function test_asset(Init memory init) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        prop_asset(caller);
    }

    function test_totalAssets(Init memory init) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        prop_totalAssets(caller);
    }

    //
    // convert
    //

    function test_convertToShares(Init memory init, uint assets) public virtual {
        setUpVault(init);
        address caller1 = init.user[0];
        address caller2 = init.user[1];
        prop_convertToShares(caller1, caller2, assets);
    }

    function test_convertToAssets(Init memory init, uint shares) public virtual {
        setUpVault(init);
        address caller1 = init.user[0];
        address caller2 = init.user[1];
        prop_convertToAssets(caller1, caller2, shares);
    }

    //
    // deposit
    //

    function test_maxDeposit(Init memory init) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        prop_maxDeposit(caller, receiver);
    }

    function test_previewDeposit(Init memory init, uint assets) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        address other    = init.user[2];
        assets = bound(assets, 0, _max_deposit(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_previewDeposit(caller, receiver, other, assets);
    }

    function test_deposit(Init memory init, uint assets, uint allowance) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        assets = bound(assets, 0, _max_deposit(caller));
        _approve(_underlying_, caller, _vault_, allowance);
        prop_deposit(caller, receiver, assets);
    }

    //
    // mint
    //

    function test_maxMint(Init memory init) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        prop_maxMint(caller, receiver);
    }

    function test_previewMint(Init memory init, uint shares) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        address other    = init.user[2];
        shares = bound(shares, 0, _max_mint(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_previewMint(caller, receiver, other, shares);
    }

    function test_mint(Init memory init, uint shares, uint allowance) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        shares = bound(shares, 0, _max_mint(caller));
        _approve(_underlying_, caller, _vault_, allowance);
        prop_mint(caller, receiver, shares);
    }

    //
    // withdraw
    //

    function test_maxWithdraw(Init memory init) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        address owner  = init.user[1];
        prop_maxWithdraw(caller, owner);
    }

    function test_previewWithdraw(Init memory init, uint assets) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        address owner    = init.user[2];
        address other    = init.user[3];
        assets = bound(assets, 0, _max_withdraw(owner));
        _approve(_vault_, owner, caller, type(uint).max);
        prop_previewWithdraw(caller, receiver, owner, other, assets);
    }

    function test_withdraw(Init memory init, uint assets, uint allowance) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        address owner    = init.user[2];
        assets = bound(assets, 0, _max_withdraw(owner));
        _approve(_vault_, owner, caller, allowance);
        prop_withdraw(caller, receiver, owner, assets);
    }

    function test_withdraw_zero_allowance(Init memory init, uint assets) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        address owner    = init.user[2];
        assets = bound(assets, 0, _max_withdraw(owner));
        vm.assume(caller != owner);
        vm.assume(assets > 0);
        _approve(_vault_, owner, caller, 0);
        vm.prank(caller);
        (bool success,) = _vault_.call(
            abi.encodeWithSelector(IERC4626.withdraw.selector, assets, receiver, owner)
        );
        assertFalse(success);
    }

    //
    // redeem
    //

    function test_maxRedeem(Init memory init) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        address owner  = init.user[1];
        prop_maxRedeem(caller, owner);
    }

    function test_previewRedeem(Init memory init, uint shares) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        address owner    = init.user[2];
        address other    = init.user[3];
        shares = bound(shares, 0, _max_redeem(owner));
        _approve(_vault_, owner, caller, type(uint).max);
        prop_previewRedeem(caller, receiver, owner, other, shares);
    }

    function test_redeem(Init memory init, uint shares, uint allowance) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        address owner    = init.user[2];
        shares = bound(shares, 0, _max_redeem(owner));
        _approve(_vault_, owner, caller, allowance);
        prop_redeem(caller, receiver, owner, shares);
    }

    function test_redeem_zero_allowance(Init memory init, uint shares) public virtual {
        setUpVault(init);
        address caller   = init.user[0];
        address receiver = init.user[1];
        address owner    = init.user[2];
        shares = bound(shares, 0, _max_redeem(owner));
        vm.assume(caller != owner);
        vm.assume(shares > 0);
        _approve(_vault_, owner, caller, 0);
        vm.prank(caller);
        (bool success,) = _vault_.call(
            abi.encodeWithSelector(IERC4626.redeem.selector, shares, receiver, owner)
        );
        assertFalse(success);
    }

    //
    // round trip tests
    //

    function test_RT_deposit_redeem(Init memory init, uint assets) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        assets = bound(assets, 0, _max_deposit(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_RT_deposit_redeem(caller, assets);
    }

    function test_RT_deposit_withdraw(Init memory init, uint assets) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        assets = bound(assets, 0, _max_deposit(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_RT_deposit_withdraw(caller, assets);
    }

    function test_RT_redeem_deposit(Init memory init, uint shares) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        shares = bound(shares, 0, _max_redeem(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_RT_redeem_deposit(caller, shares);
    }

    function test_RT_redeem_mint(Init memory init, uint shares) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        shares = bound(shares, 0, _max_redeem(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_RT_redeem_mint(caller, shares);
    }

    function test_RT_mint_withdraw(Init memory init, uint shares) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        shares = bound(shares, 0, _max_mint(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_RT_mint_withdraw(caller, shares);
    }

    function test_RT_mint_redeem(Init memory init, uint shares) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        shares = bound(shares, 0, _max_mint(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_RT_mint_redeem(caller, shares);
    }

    function test_RT_withdraw_mint(Init memory init, uint assets) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        assets = bound(assets, 0, _max_withdraw(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_RT_withdraw_mint(caller, assets);
    }

    function test_RT_withdraw_deposit(Init memory init, uint assets) public virtual {
        setUpVault(init);
        address caller = init.user[0];
        assets = bound(assets, 0, _max_withdraw(caller));
        _approve(_underlying_, caller, _vault_, type(uint).max);
        prop_RT_withdraw_deposit(caller, assets);
    }

    //
    // utils
    //

    function _isContract(address account) internal view returns (bool) { return account.code.length > 0; }
    function _isEOA     (address account) internal view returns (bool) { return account.code.length == 0; }

    function _approve(address token, address owner, address spender, uint amount) internal {
        vm.prank(owner); _safeApprove(token, spender, 0);
        vm.prank(owner); _safeApprove(token, spender, amount);
    }

    function _safeApprove(address token, address spender, uint amount) internal {
        (bool success, bytes memory retdata) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        vm.assume(success);
        if (retdata.length > 0) vm.assume(abi.decode(retdata, (bool)));
    }

    function _max_deposit(address from) internal virtual returns (uint) {
        if (_unlimitedAmount) return type(uint).max;
        return IERC20(_underlying_).balanceOf(from);
    }

    function _max_mint(address from) internal virtual returns (uint) {
        if (_unlimitedAmount) return type(uint).max;
        return vault_convertToShares(IERC20(_underlying_).balanceOf(from));
    }

    function _max_withdraw(address from) internal virtual returns (uint) {
        if (_unlimitedAmount) return type(uint).max;
        return vault_convertToAssets(IERC20(_vault_).balanceOf(from)); // may be different from maxWithdraw(from)
    }

    function _max_redeem(address from) internal virtual returns (uint) {
        if (_unlimitedAmount) return type(uint).max;
        return IERC20(_vault_).balanceOf(from); // may be different from maxRedeem(from)
    }
}
