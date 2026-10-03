import { world, system, ItemStack } from "@minecraft/server";

const CURRENCY = "minecraft:echo_shard";

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const { block, player } = event;
    const signComp = block.getComponent("minecraft:sign");
    
    if (!signComp) {
        if (block.typeId === "minecraft:chest" || block.typeId === "minecraft:barrel") {
            const lockKey = `shop_lock_${block.x}_${block.y}_${block.z}`;
            const owner = world.getDynamicProperty(lockKey);
            if (owner && player.name !== owner && !player.hasTag("admin")) {
                event.cancel = true; 
                system.run(() => {
                    player.sendMessage(`§cThis shop is locked by ${owner}.`);
                    player.playSound("note.bass");
                });
            }
        }
        return;
    }

    let text = "";
    try { text = signComp.getText(); } catch (e) { return; }
    
    const lines = text.split("\n");
    if (lines.length < 4) return;

    const header = lines[0].toLowerCase();
    
    if (header === "[shop]" || header === "[sell]" || header.includes("§9[shop]") || header.includes("§c[sell]")) {
        event.cancel = true;
        
        if (header === "[shop]" || header === "[sell]") {
            system.run(() => initializeShop(player, block, lines, header === "[shop]" ? "shop" : "sell"));
        } else if (header.includes("§9[shop]")) {
            system.run(() => processTransaction(player, block, lines, "buy"));
        } else if (header.includes("§c[sell]")) {
            system.run(() => processTransaction(player, block, lines, "sell"));
        }
    }
});

world.beforeEvents.playerBreakBlock.subscribe((event) => {
    const { block, player } = event;
    let chestBlock = null;
    
    if (block.typeId === "minecraft:chest" || block.typeId === "minecraft:barrel") {
        chestBlock = block;
    } else if (block.typeId.includes("sign")) {
        const belowBlock = block.dimension.getBlock({x: block.x, y: block.y - 1, z: block.z});
        if (belowBlock && (belowBlock.typeId === "minecraft:chest" || belowBlock.typeId === "minecraft:barrel")) {
            chestBlock = belowBlock;
        }
    }

    if (chestBlock) {
        const lockKey = `shop_lock_${chestBlock.x}_${chestBlock.y}_${chestBlock.z}`;
        const owner = world.getDynamicProperty(lockKey);

        if (owner) {
            if (player.name !== owner && !player.hasTag("admin")) {
                event.cancel = true;
                system.run(() => {
                    player.sendMessage(`§cYou cannot break ${owner}'s shop.`);
                    player.playSound("note.bass");
                });
            } else {
                system.run(() => world.setDynamicProperty(lockKey, undefined));
            }
        }
    }
});

// --- Helper Functions ---

function toNiceName(id) {
    return id.replace("minecraft:", "")
             .split("_")
             .map(word => word.charAt(0).toUpperCase() + word.slice(1))
             .join(" ");
}

function toIdName(niceName) {
    let id = niceName.toLowerCase().replace(/ /g, "_");
    return id.includes(":") ? id : "minecraft:" + id;
}

function initializeShop(player, signBlock, lines, type) {
    const amount = parseInt(lines[1]);
    const price = parseInt(lines[2]);
    const fullItemName = toIdName(lines[3].trim()); 

    if (isNaN(amount) || isNaN(price) || amount <= 0 || price <= 0) {
        player.sendMessage("§cInvalid shop! Format -> L2: Amount, L3: Price, L4: Item Name");
        player.playSound("note.bass");
        return;
    }

    const chestBlock = signBlock.dimension.getBlock({x: signBlock.x, y: signBlock.y - 1, z: signBlock.z});
    if (!chestBlock || !chestBlock.getComponent("minecraft:inventory")) {
        player.sendMessage("§cShop error: No chest found directly below this sign.");
        player.playSound("note.bass");
        return;
    }

    const lockKey = `shop_lock_${chestBlock.x}_${chestBlock.y}_${chestBlock.z}`;
    const existingOwner = world.getDynamicProperty(lockKey);
    if (existingOwner && existingOwner !== player.name) {
        player.sendMessage(`§cThis chest is already locked by ${existingOwner}.`);
        player.playSound("note.bass");
        return;
    }

    try { new ItemStack(fullItemName, 1); } catch(e) {
        player.sendMessage(`§cShop error: "${fullItemName}" is not a valid item.`);
        player.playSound("note.bass");
        return;
    }

    const signComp = signBlock.getComponent("minecraft:sign");
    const newHeader = type === "shop" ? "§9[Shop]" : "§c[Sell]";
    const niceName = toNiceName(fullItemName); 
    
    signComp.setText(`${newHeader}\n${amount}\n${price}\n${niceName}`);
    world.setDynamicProperty(lockKey, player.name);

    player.sendMessage(`§aSuccess! ${type === "shop" ? "Buy" : "Sell"} shop created and chest locked to you.`);
    player.playSound("random.anvil_use");
}

function processTransaction(player, signBlock, lines, action) {
    const amount = parseInt(lines[1]);
    const price = parseInt(lines[2]);
    const fullItemName = toIdName(lines[3].trim()); 

    const chestBlock = signBlock.dimension.getBlock({x: signBlock.x, y: signBlock.y - 1, z: signBlock.z});
    if (!chestBlock) return;
    
    const chestInvComp = chestBlock.getComponent("minecraft:inventory");
    if (!chestInvComp) {
        player.sendMessage("§cShop error: Missing chest.");
        player.playSound("note.bass");
        return;
    }

    const chestContainer = chestInvComp.container;
    const playerContainer = player.getComponent("minecraft:inventory").container;
    const niceName = toNiceName(fullItemName);

    if (action === "buy") {
        const playerCurrency = countItems(playerContainer, CURRENCY);
        if (playerCurrency < price) {
            player.sendMessage(`§cYou need ${price} Echo Shard(s).`);
            player.playSound("note.bass");
            return;
        }
        
        const chestItems = countItems(chestContainer, fullItemName);
        if (chestItems < amount) {
            player.sendMessage(`§cThis shop is out of stock!`);
            player.playSound("note.bass");
            return;
        }

        removeItems(playerContainer, CURRENCY, price);
        removeItems(chestContainer, fullItemName, amount);
        playerContainer.addItem(new ItemStack(fullItemName, amount));
        chestContainer.addItem(new ItemStack(CURRENCY, price));
        player.sendMessage(`§aBought ${amount} ${niceName} for ${price} shards.`);
        player.playSound("random.levelup");
    } 
    else if (action === "sell") {
        const playerItems = countItems(playerContainer, fullItemName);
        if (playerItems < amount) {
            player.sendMessage(`§cYou need ${amount} ${niceName} to sell.`);
            player.playSound("note.bass");
            return;
        }
        
        const chestCurrency = countItems(chestContainer, CURRENCY);
        if (chestCurrency < price) {
            player.sendMessage(`§cThis shop is out of funds!`);
            player.playSound("note.bass");
            return;
        }

        removeItems(playerContainer, fullItemName, amount);
        removeItems(chestContainer, CURRENCY, price);
        playerContainer.addItem(new ItemStack(CURRENCY, price));
        chestContainer.addItem(new ItemStack(fullItemName, amount));
        player.sendMessage(`§aSold ${amount} ${niceName} for ${price} shards.`);
        player.playSound("random.levelup");
    }
}

function countItems(container, typeId) {
    let count = 0;
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        if (item && item.typeId === typeId) count += item.amount;
    }
    return count;
}

function removeItems(container, typeId, amount) {
    let remaining = amount;
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        if (item && item.typeId === typeId) {
            if (item.amount > remaining) {
                item.amount -= remaining;
                container.setItem(i, item);
                return;
            } else {
                remaining -= item.amount;
                container.setItem(i, undefined);
            }
            if (remaining <= 0) return;
        }
    }
}