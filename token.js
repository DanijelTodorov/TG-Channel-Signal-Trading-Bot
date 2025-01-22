import mongoose from "mongoose";

const tokenSchema = new mongoose.Schema({
  address: { type: String },
  buyPrice: { type: Number },
  slPrice: { type: Number },
  sells: { type: Number, default: 0 },
});

export const TokenModel = mongoose.model("TokenModel", tokenSchema);
