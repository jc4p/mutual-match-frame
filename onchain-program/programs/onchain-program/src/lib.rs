use anchor_lang::prelude::*;

declare_id!("8dscc2LJf8HV3737bGNfjPT7JAkezNvGujdXFwgsYXDV");

#[program]
pub mod onchain_program {
    use super::*;

    // seeds = [b"crush", tag]
    pub fn submit_crush(ctx: Context<SubmitCrush>, _tag: [u8; 32], cipher: [u8;48]) -> Result<()> {
        let pda_key = ctx.accounts.crush_pda.key();
        let final_filled_value;

        { // Inner scope for mutable operations
            let crush_pda = &mut ctx.accounts.crush_pda;

            require!(crush_pda.filled < 2, ErrorCode::AlreadyMutual);

            if crush_pda.filled == 0 {
                crush_pda.cipher1 = cipher;
            } else { // filled == 1
                crush_pda.cipher2 = cipher;
            }
            crush_pda.filled += 1;
            crush_pda.bump = ctx.bumps.crush_pda; // Store bump
            final_filled_value = crush_pda.filled; // Capture the value before mutable borrow ends
        } // Mutable borrow of crush_pda (and thus ctx.accounts.crush_pda) ends here

        msg!("Crush submitted. PDA: {:?}, Filled: {}", pda_key, final_filled_value);
        Ok(())
    }
}

#[account]
// #[derive(Default)] // Removed Default as init_if_needed handles initialization
pub struct CrushPda {
  pub bump:    u8,
  pub filled:  u8,            // 0 = empty, 1 = one_sided, 2 = mutual
  pub cipher1: [u8;48],
  pub cipher2: [u8;48],
}

#[derive(Accounts)]
#[instruction(tag: [u8; 32])] // Tag is used for PDA seed
pub struct SubmitCrush<'info> {
    #[account(
        init_if_needed,
        payer = relayer,
        seeds = [b"crush", tag.as_ref()],
        bump,
        space = 8 + 1 + 1 + 48 + 48 // Discriminator (8) + bump (1) + filled (1) + cipher1 (48) + cipher2 (48) = 106
    )]
    pub crush_pda: Account<'info, CrushPda>,

    #[account(mut)]
    pub user_signer: Signer<'info>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("This crush has already been reciprocated and is mutual.")]
    AlreadyMutual,
}
