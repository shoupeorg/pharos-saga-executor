// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SagaTestToken {
    string public constant name = "Saga Test Token";
    string public constant symbol = "SGT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ALLOWANCE");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowed - amount);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_TO");
        require(balanceOf[from] >= amount, "BALANCE");
        unchecked { balanceOf[from] -= amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

interface ISagaToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ISagaVault {
    function depositFor(bytes32 sagaId, address owner, uint256 amount) external;
}

contract SagaEscrow {
    enum Status { None, Locked, Deposited, Refunded }
    struct Entry { address owner; uint256 amount; Status status; }

    ISagaToken public immutable token;
    address public immutable executor;
    mapping(bytes32 => Entry) public entries;

    event Locked(bytes32 indexed sagaId, address indexed owner, uint256 amount);
    event Deposited(bytes32 indexed sagaId, address indexed owner, address indexed vault, uint256 amount);
    event Refunded(bytes32 indexed sagaId, address indexed owner, uint256 amount);

    modifier onlyExecutor() { require(msg.sender == executor, "NOT_EXECUTOR"); _; }

    constructor(address token_, address executor_) {
        require(token_ != address(0) && executor_ != address(0), "ZERO_ADDRESS");
        token = ISagaToken(token_);
        executor = executor_;
    }

    function lock(bytes32 sagaId, address owner, uint256 amount) external onlyExecutor {
        require(entries[sagaId].status == Status.None, "SAGA_REPLAY");
        require(owner != address(0) && amount > 0, "INVALID_LOCK");
        require(token.transferFrom(owner, address(this), amount), "LOCK_TRANSFER");
        entries[sagaId] = Entry(owner, amount, Status.Locked);
        emit Locked(sagaId, owner, amount);
    }

    function deposit(bytes32 sagaId, address vault) external onlyExecutor {
        Entry storage entry = entries[sagaId];
        require(entry.status == Status.Locked, "NOT_LOCKED");
        entry.status = Status.Deposited;
        require(token.approve(vault, entry.amount), "VAULT_APPROVE");
        ISagaVault(vault).depositFor(sagaId, entry.owner, entry.amount);
        require(token.approve(vault, 0), "VAULT_REVOKE");
        emit Deposited(sagaId, entry.owner, vault, entry.amount);
    }

    function refund(bytes32 sagaId) external {
        Entry storage entry = entries[sagaId];
        require(entry.status == Status.Locked, "NOT_LOCKED");
        require(msg.sender == entry.owner || msg.sender == executor, "NOT_AUTHORIZED");
        entry.status = Status.Refunded;
        require(token.transfer(entry.owner, entry.amount), "REFUND_TRANSFER");
        emit Refunded(sagaId, entry.owner, entry.amount);
    }
}

contract SagaTestVault {
    ISagaToken public immutable token;
    address public immutable escrow;
    address public immutable executor;
    mapping(bytes32 => bool) public rejectSaga;
    mapping(bytes32 => bool) public processed;
    mapping(address => uint256) public creditOf;

    event RejectConfigured(bytes32 indexed sagaId, bool reject);
    event Credited(bytes32 indexed sagaId, address indexed owner, uint256 amount);

    modifier onlyExecutor() { require(msg.sender == executor, "NOT_EXECUTOR"); _; }

    constructor(address token_, address escrow_, address executor_) {
        token = ISagaToken(token_);
        escrow = escrow_;
        executor = executor_;
    }

    function setReject(bytes32 sagaId, bool reject) external onlyExecutor {
        require(!processed[sagaId], "ALREADY_PROCESSED");
        rejectSaga[sagaId] = reject;
        emit RejectConfigured(sagaId, reject);
    }

    function depositFor(bytes32 sagaId, address owner, uint256 amount) external {
        require(msg.sender == escrow, "NOT_ESCROW");
        require(!processed[sagaId], "SAGA_REPLAY");
        require(!rejectSaga[sagaId], "FORCED_REJECT");
        processed[sagaId] = true;
        creditOf[owner] += amount;
        require(token.transferFrom(msg.sender, address(this), amount), "DEPOSIT_TRANSFER");
        emit Credited(sagaId, owner, amount);
    }
}
