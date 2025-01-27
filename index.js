require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Connection, Keypair, Transaction, SystemProgram, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Solana connection
const solanaConn = new Connection(process.env.SOLANA_RPC_URL);
const bundlerKeypair = Keypair.fromSecretKey(
  Buffer.from(process.env.BUNDLER_PRIVATE_KEY, 'base64')
);

// Initialize Telegram bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Create database tables
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id VARCHAR(36) PRIMARY KEY,
        chat_id BIGINT,
        amount BIGINT,
        memo TEXT,
        recipient TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP
      )
    `);
    console.log('Database initialized');
  } catch (error) {
    console.error('Database initialization failed:', error);
  }
}

// Generate deposit memo
async function createDeposit(chatId, recipient) {
  const depositId = uuidv4();
  const memo = `PK-${chatId}-${depositId}`;
  
  await pool.query(
    'INSERT INTO deposits (id, chat_id, recipient, memo) VALUES ($1, $2, $3, $4)',
    [depositId, chatId, recipient, memo]
  );
  
  return {
    depositAddress: bundlerKeypair.publicKey.toString(),
    memo,
    depositId
  };
}

// Process transactions batch
async function processBatch() {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM deposits WHERE status = 'pending'"
    );

    const tx = new Transaction();
    let totalAmount = 0;

    for (const deposit of rows) {
      const recipient = new PublicKey(deposit.recipient);
      const amount = deposit.amount - 5000; // Deduct 0.000005 SOL fee
      
      tx.add(SystemProgram.transfer({
        fromPubkey: bundlerKeypair.publicKey,
        toPubkey: recipient,
        lamports: amount
      }));

      totalAmount += amount;
    }

    if (tx.instructions.length > 0) {
      const txHash = await solanaConn.sendTransaction(tx, [bundlerKeypair]);
      await solanaConn.confirmTransaction(txHash);

      // Update database
      await pool.query(
        "UPDATE deposits SET status = 'processed', processed_at = NOW() WHERE status = 'pending'"
      );

      console.log(`Batch processed: ${txHash}`);
    }
  } catch (error) {
    console.error('Batch processing error:', error);
  }
}

// Telegram commands
bot.command('start', (ctx) => {
  ctx.replyWithMarkdown(
    `👋 *Welcome to Solana Bundler Bot!*\n\n` +
    `Send /deposit <YOUR_SOLANA_ADDRESS> to start a transaction`
  );
});

bot.command('deposit', async (ctx) => {
  const recipient = ctx.message.text.split(' ')[1];
  
  try {
    new PublicKey(recipient); // Validate address
    const { depositAddress, memo } = await createDeposit(ctx.chat.id, recipient);
    
    ctx.replyWithMarkdown(
      `📤 *Send SOL to:*\n\`${depositAddress}\`\n\n` +
      `🔑 *MEMO REQUIRED:*\n\`${memo}\`\n\n` +
      `💡 Transactions batch every 5 minutes`
    );
  } catch (error) {
    ctx.reply('❌ Invalid Solana address format');
  }
});

// Initialize and start
(async () => {
  await initializeDatabase();
  setInterval(processBatch, 300000); // 5 minutes
  bot.launch();
  console.log('🤖 Bot started successfully');
})();