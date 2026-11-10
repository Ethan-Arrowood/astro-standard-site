/** Alphabet of the base32-sortable encoding used by TIDs. */
const S32_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/**
 * Generate a TID (timestamp identifier) to use as a record key. Run once per
 * record and store the result, since the key must not change across builds.
 *
 * Layout: a zero bit, 53 bits of microseconds since the Unix epoch, and a
 * 10-bit random clock ID, encoded as 13 base32-sortable characters.
 */
export function generateTid(now: number = Date.now()): string {
	const micros = BigInt(now) * 1000n;
	const clockId = BigInt(Math.floor(Math.random() * 1024));
	let value = (micros << 10n) | clockId;
	let tid = "";

	for (let i = 0; i < 13; i++) {
		tid = S32_ALPHABET[Number(value & 31n)] + tid;
		value >>= 5n;
	}

	return tid;
}
